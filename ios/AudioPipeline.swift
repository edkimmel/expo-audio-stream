import AVFoundation

/// Pipeline states reported to JS via PipelineListener.onStateChanged.
enum PipelineState: String {
    case idle = "idle"
    case connecting = "connecting"
    case streaming = "streaming"
    case draining = "draining"
    case error = "error"
}

/// Listener interface — implemented by PipelineIntegration to bridge events to JS.
protocol PipelineListener: AnyObject {
    func onStateChanged(_ state: PipelineState)
    func onPlaybackStarted(turnId: String)
    func onError(code: String, message: String)
    func onZombieDetected(stalledMs: Int64)
    func onUnderrun(count: Int)
    func onDrained(turnId: String)
    func onAudioFocusLost()
    func onAudioFocusResumed()
}

/// Core orchestrator for the native audio pipeline (iOS).
///
/// Attaches an AVAudioPlayerNode to the SharedAudioEngine, feeds it from a
/// JitterBuffer via a scheduling loop that chains buffer completions for
/// continuous output.
///
/// Key design points:
///   - The player node stays alive for the entire session, playing silence when
///     idle (via JitterBuffer returning zeros when not primed).
///   - Config is immutable per session — disconnect and reconnect to change
///     sample rate.
///   - Route changes and interruptions are handled by SharedAudioEngine;
///     this class implements SharedAudioEngineDelegate for re-seeding.
///   - Zombie detection via timer checking that the scheduling loop is active.
///   - Turn management synchronized via turnLock to prevent interleaved
///     buffer.reset + buffer.write.
class AudioPipeline: SharedAudioEngineDelegate {
    private static let TAG = "AudioPipeline"

    /// Number of buffers to pre-schedule for continuous output.
    private static let PRE_SCHEDULE_COUNT = 3

    /// How often (seconds) the state-monitoring timer fires.
    private static let STATE_POLL_INTERVAL: TimeInterval = 0.05

    /// How often (seconds) zombie detection checks.
    private static let ZOMBIE_POLL_INTERVAL: TimeInterval = 2.0

    /// If scheduling loop hasn't run for this long, declare zombie.
    private static let ZOMBIE_STALL_THRESHOLD_MS: Int64 = 5000

    // ── Config (immutable per session) ──────────────────────────────────
    private let sampleRate: Int
    private let channelCount: Int
    private let targetBufferMs: Int
    private weak var listener: PipelineListener?
    private weak var sharedEngine: SharedAudioEngine?

    // ── Core components ─────────────────────────────────────────────────
    private var playerNode: AVAudioPlayerNode?
    private var outputFormat: AVAudioFormat?
    private var jitterBuffer: JitterBuffer?

    /// Number of interleaved Int16 samples per scheduled buffer.
    let frameSizeSamples: Int

    // ── Threading / state ───────────────────────────────────────────────
    private var running = false
    private let turnLock = NSLock()
    private var currentTurnId: String?
    private var playbackStartedForTurn = false
    private var lastReportedUnderrunCount = 0
    private var isInterrupted = false

    /// Incremented each time the scheduling loop is torn down (route change, disconnect).
    /// Completion handlers capture the generation at scheduling time and bail if it's stale.
    /// This prevents duplicate chains and stale callbacks from re-entering after a rebuild.
    private var scheduleGeneration: Int = 0

    // ── Timers ──────────────────────────────────────────────────────────
    private var stateTimer: DispatchSourceTimer?
    private var zombieTimer: DispatchSourceTimer?
    private var lastScheduleTime = Date()

    // ── Pipeline state ──────────────────────────────────────────────────
    private var state: PipelineState = .idle

    // ── Telemetry ───────────────────────────────────────────────────────
    private(set) var totalPushCalls: Int64 = 0
    private(set) var totalPushBytes: Int64 = 0
    private(set) var totalScheduledBuffers: Int64 = 0

    // ── Pre-allocated render buffer ─────────────────────────────────────
    private var renderSamples: [Int16] = []

    init(sampleRate: Int, channelCount: Int, targetBufferMs: Int, sharedEngine: SharedAudioEngine, listener: PipelineListener) {
        self.sampleRate = sampleRate
        self.channelCount = channelCount
        self.targetBufferMs = targetBufferMs
        self.sharedEngine = sharedEngine
        self.listener = listener
        // 20ms frame size (matches typical iOS audio buffer duration)
        self.frameSizeSamples = max(1, sampleRate * channelCount / 50)
    }

    // ════════════════════════════════════════════════════════════════════
    // Connect / Disconnect
    // ════════════════════════════════════════════════════════════════════

    func connect() {
        guard !running else {
            Logger.debug("[\(AudioPipeline.TAG)] connect() called while already running — ignoring")
            return
        }
        setState(.connecting)

        do {
            guard let sharedEngine = sharedEngine else {
                throw NSError(domain: "AudioPipeline", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "SharedAudioEngine not set"])
            }

            // ── 1. JitterBuffer ─────────────────────────────────────────
            jitterBuffer = JitterBuffer(
                sampleRate: sampleRate,
                channels: channelCount,
                targetBufferMs: targetBufferMs
            )

            // ── 2. Pre-allocate render buffer ───────────────────────────
            renderSamples = [Int16](repeating: 0, count: frameSizeSamples)

            // ── 3. Audio session ────────────────────────────────────────
            // Session category/mode is owned by ExpoPlayAudioStreamModule
            // (ensureAudioSessionInitialized). Just ensure it's active.
            try AVAudioSession.sharedInstance().setActive(true)

            // ── 4. Create format and attach player node to shared engine ─
            guard let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: Double(sampleRate),
                channels: AVAudioChannelCount(channelCount),
                interleaved: false
            ) else {
                throw NSError(domain: "AudioPipeline", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to create audio format"])
            }

            let node = AVAudioPlayerNode()
            sharedEngine.attachNode(node, format: format)
            node.play()

            self.playerNode = node
            self.outputFormat = format
            self.running = true

            // ── 5. Start scheduling loop ────────────────────────────────
            Logger.debug("[\(AudioPipeline.TAG)] Seeding scheduling loop — gen=\(scheduleGeneration) count=\(AudioPipeline.PRE_SCHEDULE_COUNT)")
            for _ in 0..<AudioPipeline.PRE_SCHEDULE_COUNT {
                scheduleNextBuffer()
            }

            // ── 6. State polling + zombie detection ─────────────────────
            startStatePolling()
            startZombieDetection()

            // ── 7. Reset telemetry ──────────────────────────────────────
            resetTelemetry()

            setState(.idle)
            Logger.debug("[\(AudioPipeline.TAG)] Connected — sampleRate=\(sampleRate) " +
                "ch=\(channelCount) frameSamples=\(frameSizeSamples) " +
                "targetBuffer=\(targetBufferMs)ms")
        } catch {
            Logger.debug("[\(AudioPipeline.TAG)] connect() failed: \(error)")
            setState(.error)
            listener?.onError(code: "CONNECT_FAILED", message: error.localizedDescription)
            disconnect()
        }
    }

    func disconnect() {
        running = false
        // Invalidate all in-flight completion handlers before detaching.
        scheduleGeneration += 1

        // Stop timers
        stateTimer?.cancel()
        stateTimer = nil
        zombieTimer?.cancel()
        zombieTimer = nil

        // Detach node from shared engine (handles pause/stop/disconnect/detach)
        if let node = playerNode {
            sharedEngine?.detachNode(node)
        }

        playerNode = nil
        outputFormat = nil
        jitterBuffer = nil
        currentTurnId = nil

        setState(.idle)
        Logger.debug("[\(AudioPipeline.TAG)] Disconnected")
    }

    // ════════════════════════════════════════════════════════════════════
    // SharedAudioEngineDelegate
    // ════════════════════════════════════════════════════════════════════

    func engineDidRestartAfterRouteChange() {
        guard running else {
            Logger.debug("[\(AudioPipeline.TAG)] engineDidRestartAfterRouteChange — not running, skipping")
            return
        }
        let engineRunning = sharedEngine?.engine?.isRunning == true
        let nodeExists = playerNode != nil
        // Bump generation so any in-flight completions from before the rebuild are invalidated.
        // Without this, stopped-node completions that fire after isRebuilding clears would
        // re-enter the loop alongside our re-seed, doubling the scheduling chain.
        scheduleGeneration += 1
        Logger.debug("[\(AudioPipeline.TAG)] Engine restarted after route change — " +
            "re-seeding scheduling loop (gen=\(scheduleGeneration), engineRunning=\(engineRunning), node=\(nodeExists), " +
            "state=\(state.rawValue), bufferMs=\(jitterBuffer?.bufferedMs() ?? -1))")
        // Node was already re-attached and started by SharedAudioEngine.
        // Re-seed the scheduling loop with a fresh generation.
        lastScheduleTime = Date()  // Reset zombie timer baseline
        for _ in 0..<AudioPipeline.PRE_SCHEDULE_COUNT {
            scheduleNextBuffer()
        }
    }

    func engineDidRebuild() {
        guard running else {
            Logger.debug("[\(AudioPipeline.TAG)] engineDidRebuild — not running, skipping")
            return
        }

        Logger.debug("[\(AudioPipeline.TAG)] Engine rebuilt — creating fresh node and re-seeding")

        // Old node is invalid (detached during teardown). Create a fresh one.
        scheduleGeneration += 1

        guard let sharedEngine = sharedEngine,
              let format = AVAudioFormat(
                  commonFormat: .pcmFormatFloat32,
                  sampleRate: Double(sampleRate),
                  channels: AVAudioChannelCount(channelCount),
                  interleaved: false
              ) else {
            Logger.debug("[\(AudioPipeline.TAG)] engineDidRebuild — cannot create format or engine missing, treating as dead")
            running = false
            setState(.error)
            listener?.onError(code: "ENGINE_DIED", message: "Failed to recreate audio node after engine rebuild")
            return
        }

        let node = AVAudioPlayerNode()
        sharedEngine.attachNode(node, format: format)
        node.play()

        self.playerNode = node
        self.outputFormat = format

        let engineRunning = sharedEngine.engine?.isRunning == true
        let nodeExists = playerNode != nil
        Logger.debug("[\(AudioPipeline.TAG)] Fresh node attached after rebuild — " +
            "gen=\(scheduleGeneration), engineRunning=\(engineRunning), node=\(nodeExists), " +
            "state=\(state.rawValue), bufferMs=\(jitterBuffer?.bufferedMs() ?? -1))")

        // Re-seed scheduling loop
        lastScheduleTime = Date()
        for _ in 0..<AudioPipeline.PRE_SCHEDULE_COUNT {
            scheduleNextBuffer()
        }
    }

    func engineDidDie(reason: String) {
        Logger.debug("[\(AudioPipeline.TAG)] Engine died: \(reason)")
        // Stop the pipeline so all state is cleaned up.
        // Don't call disconnect() since the engine is already torn down —
        // just reset our own state.
        running = false
        scheduleGeneration += 1
        stateTimer?.cancel()
        stateTimer = nil
        zombieTimer?.cancel()
        zombieTimer = nil
        playerNode = nil
        outputFormat = nil
        jitterBuffer = nil
        currentTurnId = nil
        setState(.error)
        listener?.onError(code: "ENGINE_DIED", message: reason)
    }

    func audioSessionInterruptionBegan() {
        Logger.debug("[\(AudioPipeline.TAG)] Audio session interruption began")
        isInterrupted = true
        listener?.onAudioFocusLost()
    }

    func audioSessionInterruptionEnded() {
        Logger.debug("[\(AudioPipeline.TAG)] Audio session interruption ended")
        isInterrupted = false
        // Engine already restarted by SharedAudioEngine. Re-seed scheduling.
        if running {
            scheduleGeneration += 1
            for _ in 0..<AudioPipeline.PRE_SCHEDULE_COUNT {
                scheduleNextBuffer()
            }
        }
        listener?.onAudioFocusResumed()
    }

    // ════════════════════════════════════════════════════════════════════
    // Push audio (bridge thread → jitter buffer)
    // ════════════════════════════════════════════════════════════════════

    func pushAudio(base64Audio: String, turnId: String, isFirstChunk: Bool, isLastChunk: Bool) {
        guard let buf = jitterBuffer else {
            listener?.onError(code: "NOT_CONNECTED", message: "Pipeline not connected")
            return
        }

        turnLock.lock()
        defer { turnLock.unlock() }

        // ── Turn boundary handling ──────────────────────────────────────
        if isFirstChunk || currentTurnId != turnId {
            buf.reset()
            currentTurnId = turnId
            playbackStartedForTurn = false
            lastReportedUnderrunCount = 0
            setState(.streaming)
        }

        // ── Decode base64 → PCM shorts ──────────────────────────────────
        guard let bytes = Data(base64Encoded: base64Audio) else {
            listener?.onError(code: "DECODE_ERROR", message: "Base64 decode failed")
            return
        }

        let sampleCount = bytes.count / 2
        var samples = [Int16](repeating: 0, count: sampleCount)
        bytes.withUnsafeBytes { rawBuffer in
            guard let ptr = rawBuffer.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for i in 0..<sampleCount {
                samples[i] = Int16(littleEndian: ptr[i])
            }
        }

        // ── Write into jitter buffer ────────────────────────────────────
        buf.write(samples: samples)

        // ── Telemetry ───────────────────────────────────────────────────
        totalPushCalls += 1
        totalPushBytes += Int64(bytes.count)

        // ── End-of-stream ───────────────────────────────────────────────
        if isLastChunk {
            buf.markEndOfStream()
            setState(.draining)
        }
    }

    /// Invalidate the current turn. Resets the jitter buffer so stale audio
    /// is discarded immediately.
    func invalidateTurn(newTurnId: String) {
        turnLock.lock()
        defer { turnLock.unlock() }
        jitterBuffer?.reset()
        currentTurnId = newTurnId
        playbackStartedForTurn = false
        lastReportedUnderrunCount = 0
        setState(.idle)
    }

    // ════════════════════════════════════════════════════════════════════
    // State & Telemetry
    // ════════════════════════════════════════════════════════════════════

    func getState() -> PipelineState { return state }

    func getTelemetry() -> [String: Any] {
        let buf = jitterBuffer
        return [
            "state": state.rawValue,
            "bufferMs": buf?.bufferedMs() ?? 0,
            "bufferSamples": buf?.availableSamples() ?? 0,
            "primed": buf?.isPrimed() ?? false,
            "totalWritten": buf?.totalWritten ?? 0,
            "totalRead": buf?.totalRead ?? 0,
            "underrunCount": buf?.underrunCount ?? 0,
            "peakLevel": buf?.peakLevel ?? 0,
            "totalPushCalls": totalPushCalls,
            "totalPushBytes": totalPushBytes,
            "totalScheduledBuffers": totalScheduledBuffers,
            "turnId": currentTurnId ?? ""
        ]
    }

    // ════════════════════════════════════════════════════════════════════
    // Scheduling loop
    // ════════════════════════════════════════════════════════════════════

    private func scheduleNextBuffer() {
        guard running,
              let se = sharedEngine, !se.isRebuilding,
              let buf = jitterBuffer,
              let node = playerNode,
              let format = outputFormat,
              se.engine?.isRunning == true else { return }

        // Capture the current generation so the completion handler can detect staleness.
        let capturedGeneration = scheduleGeneration

        // Read interleaved Int16 samples from jitter buffer
        buf.read(dest: &renderSamples, length: frameSizeSamples)

        // Convert to non-interleaved Float32 for AVAudioEngine
        let framesPerBuffer = frameSizeSamples / channelCount
        guard let pcmBuffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(framesPerBuffer)
        ) else { return }
        pcmBuffer.frameLength = AVAudioFrameCount(framesPerBuffer)

        if let channelData = pcmBuffer.floatChannelData {
            if isInterrupted {
                // Write silence during interruption
                for ch in 0..<channelCount {
                    for i in 0..<framesPerBuffer {
                        channelData[ch][i] = 0
                    }
                }
            } else {
                // De-interleave Int16 → non-interleaved Float32
                for frame in 0..<framesPerBuffer {
                    for ch in 0..<channelCount {
                        let sampleIndex = frame * channelCount + ch
                        channelData[ch][frame] = Float(renderSamples[sampleIndex]) / 32768.0
                    }
                }
            }
        }

        totalScheduledBuffers += 1
        lastScheduleTime = Date()

        node.scheduleBuffer(pcmBuffer) { [weak self] in
            guard let self = self, self.running else { return }
            // Bail if this completion belongs to a previous scheduling generation
            // (route change rebuilt the engine while this buffer was in flight).
            guard self.scheduleGeneration == capturedGeneration else { return }
            self.scheduleNextBuffer()
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // State polling (runs on main thread via GCD timer)
    // ════════════════════════════════════════════════════════════════════

    private func startStatePolling() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(
            deadline: .now() + AudioPipeline.STATE_POLL_INTERVAL,
            repeating: AudioPipeline.STATE_POLL_INTERVAL)
        timer.setEventHandler { [weak self] in
            self?.checkBufferState()
        }
        timer.resume()
        stateTimer = timer
    }

    private func checkBufferState() {
        guard let buf = jitterBuffer else { return }

        turnLock.lock()
        let turnId = currentTurnId
        let alreadyStarted = playbackStartedForTurn
        let lastUnderruns = lastReportedUnderrunCount
        let currentState = state
        turnLock.unlock()

        // ── Playback-started event (once per turn) ──────────────────────
        if !alreadyStarted && buf.isPrimed() && turnId != nil {
            turnLock.lock()
            playbackStartedForTurn = true
            turnLock.unlock()
            listener?.onPlaybackStarted(turnId: turnId!)
        }

        // ── Underrun debounce ───────────────────────────────────────────
        let currentUnderruns = buf.underrunCount
        if currentUnderruns > lastUnderruns {
            turnLock.lock()
            lastReportedUnderrunCount = currentUnderruns
            turnLock.unlock()
            listener?.onUnderrun(count: currentUnderruns)
        }

        // ── Drain detection ─────────────────────────────────────────────
        if buf.isDrained() && currentState == .draining {
            if let tid = turnId {
                listener?.onDrained(turnId: tid)
            }
            setState(.idle)
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Zombie detection
    // ════════════════════════════════════════════════════════════════════

    private func startZombieDetection() {
        lastScheduleTime = Date()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(
            deadline: .now() + AudioPipeline.ZOMBIE_POLL_INTERVAL,
            repeating: AudioPipeline.ZOMBIE_POLL_INTERVAL)
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            let stalledMs = Int64(Date().timeIntervalSince(self.lastScheduleTime) * 1000)
            if stalledMs >= AudioPipeline.ZOMBIE_STALL_THRESHOLD_MS &&
               (self.state == .streaming || self.state == .draining) {
                Logger.debug("[\(AudioPipeline.TAG)] Zombie detected! stalledMs=\(stalledMs)")
                self.listener?.onZombieDetected(stalledMs: stalledMs)
                self.lastScheduleTime = Date()
            }
        }
        timer.resume()
        zombieTimer = timer
    }

    // ════════════════════════════════════════════════════════════════════
    // Internal helpers
    // ════════════════════════════════════════════════════════════════════

    private func setState(_ newState: PipelineState) {
        guard state != newState else { return }
        state = newState
        if Thread.isMainThread {
            listener?.onStateChanged(newState)
        } else {
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.listener?.onStateChanged(newState)
            }
        }
    }

    private func resetTelemetry() {
        totalPushCalls = 0
        totalPushBytes = 0
        totalScheduledBuffers = 0
        jitterBuffer?.resetTelemetry()
    }
}
