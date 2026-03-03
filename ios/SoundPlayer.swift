import AVFoundation
import ExpoModulesCore

class SoundPlayer: SharedAudioEngineDelegate {
    weak var delegate: SoundPlayerDelegate?
    private var audioPlayerNode: AVAudioPlayerNode!
    private weak var sharedEngine: SharedAudioEngine?

    private let bufferAccessQueue = DispatchQueue(label: "com.expoaudiostream.bufferAccessQueue")

    private var audioQueue: [(buffer: AVAudioPCMBuffer, promise: RCTPromiseResolveBlock, turnId: String)] = []  // Queue for audio segments
    // needed to track segments in progress in order to send playbackevents properly
    private var segmentsLeftToPlay: Int = 0
    private var isPlaying: Bool = false  // Tracks if audio is currently playing
    public var isAudioEngineIsSetup: Bool = false

    // specific turnID to ignore sound events
    internal let suspendSoundEventTurnId: String = "suspend-sound-events"

    // Debounce mechanism for isFinal signal - prevents premature isFinal when chunks arrive with network latency
    private var pendingFinalWorkItem: DispatchWorkItem?
    private let finalDebounceDelay: TimeInterval = 0.8  // 800ms for smooth debounce

    private var audioPlaybackFormat: AVAudioFormat!
    private var config: SoundConfig

    init(config: SoundConfig = SoundConfig()) {
        self.config = config
        self.audioPlaybackFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: config.sampleRate, channels: 1, interleaved: false)
    }

    /// Set the shared audio engine reference. Called by the module after creation.
    func setSharedEngine(_ engine: SharedAudioEngine) {
        self.sharedEngine = engine
    }
    
    // ── SharedAudioEngineDelegate ────────────────────────────────────────

    func engineDidRestartAfterRouteChange() {
        Logger.debug("[SoundPlayer] Engine restarted after route change")
        // Node has already been re-attached and played by SharedAudioEngine.
        // Notify delegate so JS layer knows about the route change.
        self.delegate?.onDeviceReconnected(.newDeviceAvailable)

        // Re-trigger playback if there are still queued buffers.
        // The scheduling chain was broken when the node was stopped during rebuild.
        self.bufferAccessQueue.async { [weak self] in
            guard let self = self else { return }
            if !self.audioQueue.isEmpty {
                Logger.debug("[SoundPlayer] Re-scheduling \(self.audioQueue.count) queued buffers after route change")
                self.playNextInQueue()
            }
        }
    }

    func engineDidRebuild() {
        Logger.debug("[SoundPlayer] Engine rebuilt — creating fresh node")
        // Old node is invalid. Nil it out and set up a fresh one.
        self.audioPlayerNode = nil
        self.isAudioEngineIsSetup = false

        do {
            try ensureAudioEngineIsSetup()
            Logger.debug("[SoundPlayer] Fresh node attached after rebuild")
        } catch {
            Logger.debug("[SoundPlayer] Failed to create fresh node after rebuild: \(error)")
            // Fall through — next play() call will retry ensureAudioEngineIsSetup
        }

        // Notify JS about the route change
        self.delegate?.onDeviceReconnected(.newDeviceAvailable)

        // Re-trigger playback if there are still queued buffers
        self.bufferAccessQueue.async { [weak self] in
            guard let self = self else { return }
            if !self.audioQueue.isEmpty {
                Logger.debug("[SoundPlayer] Re-scheduling \(self.audioQueue.count) queued buffers after rebuild")
                self.playNextInQueue()
            }
        }
    }

    func audioSessionInterruptionBegan() {
        Logger.debug("[SoundPlayer] Audio session interruption began")
        // Nothing specific needed — playback buffers just won't produce sound.
    }

    func audioSessionInterruptionEnded() {
        Logger.debug("[SoundPlayer] Audio session interruption ended")
        // Engine already restarted by SharedAudioEngine. Node re-started.
        // If there are queued buffers, playback continues automatically.
    }

    func engineDidDie(reason: String) {
        Logger.debug("[SoundPlayer] Engine died: \(reason)")
        // Clear our node reference — engine is already torn down.
        self.audioPlayerNode = nil
        self.isAudioEngineIsSetup = false

        // Clear queued buffers and notify JS
        self.bufferAccessQueue.async { [weak self] in
            guard let self = self else { return }
            self.pendingFinalWorkItem?.cancel()
            self.pendingFinalWorkItem = nil
            self.audioQueue.removeAll()
            self.segmentsLeftToPlay = 0
        }

        // Notify JS layer about the device issue
        DispatchQueue.main.async { [weak self] in
            self?.delegate?.onDeviceReconnected(.oldDeviceUnavailable)
        }
    }

    /// Detaches and cleans up the existing audio player node from the shared engine
    private func detachOldAvNodesFromEngine() {
        Logger.debug("[SoundPlayer] Detaching old audio node")
        guard let playerNode = self.audioPlayerNode else { return }

        sharedEngine?.detachNode(playerNode)

        // Set to nil, ARC deallocates it if no other references exist
        self.audioPlayerNode = nil
    }
    
    /// Updates the audio configuration and re-attaches the player node with the new format.
    ///
    /// Engine reconfiguration (for playbackMode changes) is handled by the module
    /// via `SharedAudioEngine.configure()` before calling this method.
    ///
    /// - Parameter newConfig: The new configuration to apply
    /// - Throws: Error if node setup fails
    public func updateConfig(_ newConfig: SoundConfig) throws {
        Logger.debug("[SoundPlayer] Updating configuration - sampleRate: \(newConfig.sampleRate), playbackMode: \(newConfig.playbackMode)")

        // Check if anything has changed
        let configChanged = newConfig.sampleRate != self.config.sampleRate ||
                           newConfig.playbackMode != self.config.playbackMode

        guard configChanged else {
            Logger.debug("[SoundPlayer] Configuration unchanged, skipping update")
            return
        }

        // Detach existing node
        self.detachOldAvNodesFromEngine()

        // Update configuration
        self.config = newConfig

        // Update format with new sample rate
        self.audioPlaybackFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: newConfig.sampleRate, channels: 1, interleaved: false)

        // Attach a fresh node with the new format
        try self.ensureAudioEngineIsSetup()
    }
    
    /// Resets the audio configuration to default values and reconfigures the audio engine
    /// - Throws: Error if audio engine setup fails
    public func resetConfigToDefault() throws {
        Logger.debug("[SoundPlayer] Resetting configuration to default values")
        try updateConfig(SoundConfig.defaultConfig)
    }
    
    /// Attaches a fresh player node to the shared engine.
    /// - Throws: Error if shared engine is not available
    public func ensureAudioEngineIsSetup() throws {
        guard let sharedEngine = self.sharedEngine else {
            throw NSError(domain: "SoundPlayer", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "SharedAudioEngine not set"])
        }

        // Detach any existing node first
        self.detachOldAvNodesFromEngine()

        // Create a fresh player node and attach to the shared engine
        let node = AVAudioPlayerNode()
        sharedEngine.attachNode(node, format: self.audioPlaybackFormat)
        self.audioPlayerNode = node
        self.isAudioEngineIsSetup = true

        Logger.debug("[SoundPlayer] Node attached to shared engine — sampleRate=\(config.sampleRate)")
    }
    
    /// Clears all pending audio chunks from the playback queue
    /// - Parameter promise: Promise to resolve when queue is cleared
    func clearSoundQueue(turnIdToClear turnId: String = "", resolver promise: Promise) {
        Logger.debug("[SoundPlayer] Clearing Sound Queue...")
        self.bufferAccessQueue.async { [weak self] in
            guard let self = self else {
                promise.resolve(nil)
                return
            }
            
            // Cancel any pending final signal when clearing queue
            self.pendingFinalWorkItem?.cancel()
            self.pendingFinalWorkItem = nil
            
            if !self.audioQueue.isEmpty {
                Logger.debug("[SoundPlayer] Queue is not empty clearing")
                let removedCount = self.audioQueue.filter { $0.turnId == turnId }.count
                self.audioQueue.removeAll(where: { $0.turnId == turnId })
                // Adjust segmentsLeftToPlay to account for removed items
                self.segmentsLeftToPlay = max(0, self.segmentsLeftToPlay - removedCount)
            } else {
                Logger.debug("[SoundPlayer] Queue is empty")
            }
            promise.resolve(nil)
        }
    }
    
    /// Stops audio playback and clears the queue
    /// - Parameter promise: Promise to resolve when stopped
    func stop(_ promise: Promise) {
        Logger.debug("[SoundPlayer] Stopping Audio")

        // Stop the audio player node (engine stays running — it's shared)
        if self.audioPlayerNode != nil && self.audioPlayerNode.isPlaying {
            Logger.debug("[SoundPlayer] Player is playing, stopping")
            self.audioPlayerNode.pause()
            self.audioPlayerNode.stop()
        } else {
            Logger.debug("Player is not playing")
        }

        // Clear queue and reset segment count on bufferAccessQueue for thread safety
        self.bufferAccessQueue.async { [weak self] in
            guard let self = self else {
                promise.resolve(nil)
                return
            }

            // Cancel any pending final signal
            self.pendingFinalWorkItem?.cancel()
            self.pendingFinalWorkItem = nil

            if !self.audioQueue.isEmpty {
                Logger.debug("[SoundPlayer] Queue is not empty clearing")
                self.audioQueue.removeAll()
            }
            self.segmentsLeftToPlay = 0
            promise.resolve(nil)
        }
    }

    /// Processes audio chunk based on common format
    /// - Parameters:
    ///   - base64String: Base64 encoded audio data
    ///   - commonFormat: The common format of the audio data
    /// - Returns: Processed audio buffer or nil if processing fails
    /// - Throws: SoundPlayerError if format is unsupported
    private func processAudioChunk(_ base64String: String, commonFormat: AVAudioCommonFormat) throws -> AVAudioPCMBuffer? {
        switch commonFormat {
        case .pcmFormatFloat32:
            return AudioUtils.processFloat32LEAudioChunk(base64String, audioFormat: self.audioPlaybackFormat)
        case .pcmFormatInt16:
            return AudioUtils.processPCM16LEAudioChunk(base64String, audioFormat: self.audioPlaybackFormat)
        default:
            Logger.debug("[SoundPlayer] Unsupported audio format: \(commonFormat)")
            throw SoundPlayerError.unsupportedFormat
        }
    }
    
    /// Plays an audio chunk from base64 encoded string
    /// - Parameters:
    ///   - base64String: Base64 encoded audio data
    ///   - strTurnId: Identifier for the turn/segment
    ///   - resolver: Promise resolver callback
    ///   - rejecter: Promise rejection callback
    ///   - commonFormat: The common format of the audio data (defaults to .pcmFormatFloat32)
    /// - Throws: Error if audio processing fails
    public func play(
        audioChunk base64String: String,
        turnId strTurnId: String,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock,
        commonFormat: AVAudioCommonFormat = .pcmFormatFloat32
    ) throws {
        do {
            if !self.isAudioEngineIsSetup {
                try ensureAudioEngineIsSetup()
            }
            
            guard let buffer = try processAudioChunk(base64String, commonFormat: commonFormat) else {
                Logger.debug("[SoundPlayer] Failed to process audio chunk")
                throw SoundPlayerError.invalidBase64String
            }
            
            // Use bufferAccessQueue for all queue and segment count access to ensure thread safety
            self.bufferAccessQueue.async { [weak self] in
                guard let self = self else {
                    resolver(nil)
                    return
                }
                
                // Cancel any pending "final" signal - new chunk arrived, so we're not done yet
                self.pendingFinalWorkItem?.cancel()
                self.pendingFinalWorkItem = nil

                let bufferTuple = (buffer: buffer, promise: resolver, turnId: strTurnId)
                self.audioQueue.append(bufferTuple)
                if self.segmentsLeftToPlay == 0 && strTurnId != self.suspendSoundEventTurnId {
                    DispatchQueue.main.async {
                        self.delegate?.onSoundStartedPlaying()
                    }
                }
                self.segmentsLeftToPlay += 1
                // If not already playing, start playback
                if self.audioQueue.count == 1 {
                    self.playNextInQueue()
                }
            }
        } catch {
            Logger.debug("[SoundPlayer] Failed to enqueue audio chunk: \(error.localizedDescription)")
            rejecter("ERROR_SOUND_PLAYER", "Failed to enqueue audio chunk: \(error.localizedDescription)", nil)
        }
    }
    
    /// Plays the next audio buffer in the queue
    /// This method is responsible for:
    /// 1. Checking if there are audio chunks in the queue
    /// 2. Starting the audio player node if it's not already playing
    /// 3. Scheduling the next audio buffer for playback
    /// 4. Handling completion callbacks and recursively playing the next chunk
    /// - Note: This method should be called from bufferAccessQueue to ensure thread safety
    private func playNextInQueue() {
        // Ensure we're on the buffer access queue for thread safety
        // If called from elsewhere, dispatch to the queue
        dispatchPrecondition(condition: .onQueue(bufferAccessQueue))
        
        // Bail out if the shared engine is mid-rebuild (route change).
        // engineDidRestartAfterRouteChange will re-trigger us when ready.
        if sharedEngine?.isRebuilding == true {
            Logger.debug("[SoundPlayer] Engine rebuilding — deferring playNextInQueue")
            return
        }

        // Check if queue is empty
        guard !self.audioQueue.isEmpty else {
            Logger.debug("[SoundPlayer] Queue is empty, nothing to play")
            return
        }

        // Start the audio player node if it's not already playing
        if !self.audioPlayerNode.isPlaying {
            Logger.debug("[SoundPlayer] Starting Player")
            self.audioPlayerNode.play()
        }
        
        // Get the first buffer tuple from the queue (buffer, promise, turnId)
        if let (buffer, promise, turnId) = self.audioQueue.first {
            // Remove the buffer from the queue immediately to avoid playing it twice
            self.audioQueue.removeFirst()

            // Schedule the buffer for playback with a completion handler
            self.audioPlayerNode.scheduleBuffer(buffer) { [weak self] in
                guard let self = self else {
                    promise(nil)
                    return
                }
                
                // Use bufferAccessQueue for all queue and segment count access
                self.bufferAccessQueue.async {
                    // Decrement the count of segments left to play
                    self.segmentsLeftToPlay -= 1

                    // Check if this is the final segment in the current sequence
                    let isFinalSegment = self.segmentsLeftToPlay == 0
                    
                    // Resolve the promise on main thread
                    DispatchQueue.main.async {
                        promise(nil)
                    }
                    
                    // ✅ Notify delegate about playback completion
                    if turnId != self.suspendSoundEventTurnId {
                        if isFinalSegment {
                            // Debounce the isFinal signal - wait to see if more chunks arrive
                            // This prevents premature isFinal when chunks arrive with network latency
                            let workItem = DispatchWorkItem { [weak self] in
                                guard let self = self else { return }
                                // Double-check we're still at 0 segments (no new chunks arrived)
                                if self.segmentsLeftToPlay == 0 {
                                    Logger.debug("[SoundPlayer] Debounced isFinal - no more chunks arrived, sending isFinal: true")
                                    DispatchQueue.main.async {
                                        self.delegate?.onSoundChunkPlayed(true)
                                    }
                                }
                            }
                            self.pendingFinalWorkItem = workItem
                            self.bufferAccessQueue.asyncAfter(deadline: .now() + self.finalDebounceDelay, execute: workItem)
                        } else {
                            // Not the final segment, send immediately
                            DispatchQueue.main.async {
                                self.delegate?.onSoundChunkPlayed(false)
                            }
                        }
                    }
                    
                    // Recursively play the next chunk if queue is not empty
                    if !self.audioQueue.isEmpty {
                        self.playNextInQueue()
                    }
                }
            }
        }
    }
}
