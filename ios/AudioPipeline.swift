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
/// Creates an AVAudioEngine with an AVAudioPlayerNode, a JitterBuffer ring,
/// and a scheduling loop that chains buffer completions to maintain continuous
/// output.
///
/// Key design points:
///   - The player node stays alive for the entire session, playing silence when
///     idle (via JitterBuffer returning zeros when not primed).
///   - Config is immutable per session — disconnect and reconnect to change
///     sample rate.
///   - Interruption handling via AVAudioSession.interruptionNotification
///     (iOS equivalent of Android audio focus).
///   - Zombie detection via timer checking that the scheduling loop is active.
///   - Turn management synchronized via turnLock to prevent interleaved
///     buffer.reset + buffer.write.
class AudioPipeline {
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

    // ── Core components ─────────────────────────────────────────────────
    private var audioEngine: AVAudioEngine?
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

    init(sampleRate: Int, channelCount: Int, targetBufferMs: Int, listener: PipelineListener) {
        self.sampleRate = sampleRate
        self.channelCount = channelCount
        self.targetBufferMs = targetBufferMs
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
            // ── 1. JitterBuffer ─────────────────────────────────────────
            // Ring capacity: 10 seconds of audio
            let ringCapacity = sampleRate * channelCount * 10
            jitterBuffer = JitterBuffer(
                sampleRate: sampleRate,
                channels: channelCount,
                targetBufferMs: targetBufferMs,
                capacitySamples: ringCapacity
            )

            // ── 2. Pre-allocate render buffer ───────────────────────────
            renderSamples = [Int16](repeating: 0, count: frameSizeSamples)

            // ── 3. Audio session ────────────────────────────────────────
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord, mode: .default,
                options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true)

            // ── 4. AVAudioEngine + PlayerNode ───────────────────────────
            let engine = AVAudioEngine()
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
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: format)

            try engine.start()
            node.play()

            self.audioEngine = engine
            self.playerNode = node
            self.outputFormat = format
            self.running = true

            // ── 5. Interruption handling ────────────────────────────────
            NotificationCenter.default.addObserver(
                self, selector: #selector(handleInterruption),
                name: AVAudioSession.interruptionNotification, object: nil)

            // ── 6. Start scheduling loop ────────────────────────────────
            for _ in 0..<AudioPipeline.PRE_SCHEDULE_COUNT {
                scheduleNextBuffer()
            }

            // ── 7. State polling + zombie detection ─────────────────────
            startStatePolling()
            startZombieDetection()

            // ── 8. Reset telemetry ──────────────────────────────────────
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

        // Stop timers
        stateTimer?.cancel()
        stateTimer = nil
        zombieTimer?.cancel()
        zombieTimer = nil

        // Remove observers
        NotificationCenter.default.removeObserver(
            self, name: AVAudioSession.interruptionNotification, object: nil)

        // Stop player node (unschedules all pending buffers)
        playerNode?.stop()

        // Stop engine
        audioEngine?.stop()

        // Detach node
        if let node = playerNode {
            audioEngine?.detach(node)
        }

        playerNode = nil
        audioEngine = nil
        outputFormat = nil
        jitterBuffer = nil
        currentTurnId = nil

        setState(.idle)
        Logger.debug("[\(AudioPipeline.TAG)] Disconnected")
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
              let buf = jitterBuffer,
              let node = playerNode,
              let format = outputFormat,
              audioEngine?.isRunning == true else { return }

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
    // Interruption handling (iOS equivalent of Android audio focus)
    // ════════════════════════════════════════════════════════════════════

    @objc private func handleInterruption(notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }

        if type == .began {
            Logger.debug("[\(AudioPipeline.TAG)] Audio session interruption began")
            isInterrupted = true
            listener?.onAudioFocusLost()
        } else if type == .ended {
            Logger.debug("[\(AudioPipeline.TAG)] Audio session interruption ended")
            isInterrupted = false
            // Reactivate session and restart engine if needed
            try? AVAudioSession.sharedInstance().setActive(true)
            if let engine = audioEngine, !engine.isRunning {
                do {
                    try engine.start()
                    playerNode?.play()
                    // Re-seed the scheduling loop
                    for _ in 0..<AudioPipeline.PRE_SCHEDULE_COUNT {
                        scheduleNextBuffer()
                    }
                } catch {
                    Logger.debug("[\(AudioPipeline.TAG)] Failed to restart after interruption: \(error)")
                    listener?.onError(code: "RESTART_FAILED", message: error.localizedDescription)
                }
            }
            listener?.onAudioFocusResumed()
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
