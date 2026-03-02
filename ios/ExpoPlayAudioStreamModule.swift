import Foundation
import AVFoundation
import ExpoModulesCore

let audioDataEvent: String = "AudioData"
let soundIsPlayedEvent: String = "SoundChunkPlayed"
let soundIsStartedEvent: String = "SoundStarted"
let deviceReconnectedEvent: String = "DeviceReconnected"


public class ExpoPlayAudioStreamModule: Module, MicrophoneDataDelegate, SoundPlayerDelegate, PipelineEventSender {
    private var _microphone: Microphone?
    private var _soundPlayer: SoundPlayer?
    private var _pipelineIntegration: PipelineIntegration?

    private var microphone: Microphone {
        if _microphone == nil {
            _microphone = Microphone()
            _microphone?.delegate = self
        }
        return _microphone!
    }

    private var soundPlayer: SoundPlayer {
        if _soundPlayer == nil {
            _soundPlayer = SoundPlayer()
            _soundPlayer?.delegate = self
        }
        return _soundPlayer!
    }

    private var pipelineIntegration: PipelineIntegration {
        if _pipelineIntegration == nil {
            _pipelineIntegration = PipelineIntegration(eventSender: self)
        }
        return _pipelineIntegration!
    }

    private var isAudioSessionInitialized: Bool = false

    // ── PipelineEventSender conformance ───────────────────────────────
    func sendPipelineEvent(_ eventName: String, _ params: [String: Any]) {
        sendEvent(eventName, params)
    }

    public func definition() -> ModuleDefinition {
        Name("ExpoPlayAudioStream")

        // Defines event names that the module can send to JavaScript.
        Events([
            audioDataEvent,
            soundIsPlayedEvent,
            soundIsStartedEvent,
            deviceReconnectedEvent,
            PipelineIntegration.EVENT_STATE_CHANGED,
            PipelineIntegration.EVENT_PLAYBACK_STARTED,
            PipelineIntegration.EVENT_ERROR,
            PipelineIntegration.EVENT_ZOMBIE_DETECTED,
            PipelineIntegration.EVENT_UNDERRUN,
            PipelineIntegration.EVENT_DRAINED,
            PipelineIntegration.EVENT_AUDIO_FOCUS_LOST,
            PipelineIntegration.EVENT_AUDIO_FOCUS_RESUMED,
        ])

        Function("destroy") {
            self._pipelineIntegration?.destroy()
            self._pipelineIntegration = nil
            if self.isAudioSessionInitialized {
                let audioSession = AVAudioSession.sharedInstance()
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                self.isAudioSessionInitialized = false
            }
            self._microphone = nil
            self._soundPlayer = nil
        }

        /// Prompts the user to select the microphone mode.
        Function("promptMicrophoneModes") {
            promptForMicrophoneModes()
        }

        /// Requests microphone permission from the user.
        AsyncFunction("requestPermissionsAsync") { (promise: Promise) in
            checkMicrophonePermission { granted in
                promise.resolve([
                    "granted": granted,
                    "canAskAgain": true,
                    "status": granted ? "granted" : "denied"
                ])
            }
        }

        /// Gets the current microphone permission status.
        AsyncFunction("getPermissionsAsync") { (promise: Promise) in
            let status = AVAudioSession.sharedInstance().recordPermission
            let granted = status == .granted
            let canAskAgain = status == .undetermined
            promise.resolve([
                "granted": granted,
                "canAskAgain": canAskAgain,
                "status": granted ? "granted" : (canAskAgain ? "undetermined" : "denied")
            ])
        }

        AsyncFunction("playSound") { (base64Chunk: String, turnId: String, encoding: String?, promise: Promise) in
            Logger.debug("Play sound")
            do {
                if !isAudioSessionInitialized {
                    try ensureAudioSessionInitialized()
                }

                // Determine the audio format based on the encoding parameter
                let commonFormat: AVAudioCommonFormat
                switch encoding {
                case "pcm_f32le":
                    commonFormat = .pcmFormatFloat32
                case "pcm_s16le", nil:
                    commonFormat = .pcmFormatInt16
                default:
                    Logger.debug("[ExpoPlayAudioStreamModule] Unsupported encoding: \(encoding ?? "nil"), defaulting to PCM_S16LE")
                    commonFormat = .pcmFormatInt16
                }

                try soundPlayer.play(audioChunk: base64Chunk, turnId: turnId, resolver: {
                    _ in promise.resolve(nil)
                }, rejecter: {code, message, error in
                    promise.reject(code ?? "ERR_UNKNOWN", message ?? "Unknown error")
                }, commonFormat: commonFormat)
            } catch {
                print("Error enqueuing audio: \(error.localizedDescription)")
            }
        }

        AsyncFunction("stopSound") { (promise: Promise) in
            soundPlayer.stop(promise)
        }

        AsyncFunction("clearSoundQueueByTurnId") { (turnId: String, promise: Promise) in
            soundPlayer.clearSoundQueue(turnIdToClear: turnId, resolver: promise)
        }

        AsyncFunction("startMicrophone") { (options: [String: Any], promise: Promise) in
            // Create recording settings
            // Extract settings from provided options, using default values if necessary
            let sampleRate = options["sampleRate"] as? Double ?? 16000.0 // it fails if not 48000, why?
            let numberOfChannels = options["channelConfig"] as? Int ?? 1 // Mono channel configuration
            let bitDepth = options["audioFormat"] as? Int ?? 16 // 16bits
            let interval = options["interval"] as? Int ?? 1000

            let settings = RecordingSettings(
                sampleRate: sampleRate,
                desiredSampleRate: sampleRate,
                numberOfChannels: numberOfChannels,
                bitDepth: bitDepth,
                maxRecentDataDuration: nil,
                pointsPerSecond: nil
            )

            if !isAudioSessionInitialized {
                do {
                    try ensureAudioSessionInitialized(settings: settings)
                } catch {
                    promise.reject("ERROR", "Failed to init audio session \(error.localizedDescription)")
                    return
                }
            }

            if let result = self.microphone.startRecording(settings: settings, intervalMilliseconds: interval) {
                if let resError = result.error {
                    promise.reject("ERROR", resError)
                } else {
                    let resultDict: [String: Any] = [
                        "fileUri": result.fileUri ?? "",
                        "channels": result.channels ?? 1,
                        "bitDepth": result.bitDepth ?? 16,
                        "sampleRate": result.sampleRate ?? 48000,
                        "mimeType": result.mimeType ?? "",
                    ]
                    promise.resolve(resultDict)
                }
            } else {
                promise.reject("ERROR", "Failed to start recording.")
            }
        }

        /// Stops the microphone recording and releases associated resources
        /// - Parameter promise: A promise to resolve when microphone recording is stopped
        /// - Note: This method stops the active recording session, processes any remaining audio data,
        ///         and releases hardware resources. It should be called when the app no longer needs
        ///         microphone access to conserve battery and system resources.
        AsyncFunction("stopMicrophone") { (promise: Promise) in
            microphone.stopRecording(resolver: promise)
        }

        Function("toggleSilence") { (isSilent: Bool) in
            microphone.toggleSilence(isSilent)
        }

        /// Sets the sound player configuration
        /// - Parameters:
        ///   - config: A dictionary containing configuration options:
        ///     - `sampleRate`: The sample rate for audio playback (default is 16000.0).
        ///     - `playbackMode`: The playback mode ("regular", "voiceProcessing", or "conversation").
        ///     - `useDefault`: When true, resets to default configuration regardless of other parameters.
        ///   - promise: A promise to resolve when configuration is updated or reject with an error.
        AsyncFunction("setSoundConfig") { (config: [String: Any], promise: Promise) in
            // Check if we should use default configuration
            let useDefault = config["useDefault"] as? Bool ?? false

            do {
                if !isAudioSessionInitialized {
                    try ensureAudioSessionInitialized()
                }

                if useDefault {
                    // Reset to default configuration
                    Logger.debug("[ExpoPlayAudioStreamModule] Resetting sound configuration to default values")
                    try soundPlayer.resetConfigToDefault()
                } else {
                    // Extract configuration values from the provided dictionary
                    let sampleRate = config["sampleRate"] as? Double ?? 16000.0
                    let playbackModeString = config["playbackMode"] as? String ?? "regular"

                    // Convert string playback mode to enum
                    let playbackMode: PlaybackMode
                    switch playbackModeString {
                    case "voiceProcessing":
                        playbackMode = .voiceProcessing
                    case "conversation":
                        playbackMode = .conversation
                    default:
                        playbackMode = .regular
                    }

                    // Create a new SoundConfig object
                    let soundConfig = SoundConfig(sampleRate: sampleRate, playbackMode: playbackMode)

                    // Update the sound player configuration
                    Logger.debug("[ExpoPlayAudioStreamModule] Setting sound configuration - sampleRate: \(sampleRate), playbackMode: \(playbackModeString)")
                    try soundPlayer.updateConfig(soundConfig)
                }

                promise.resolve(nil)
            } catch {
                promise.reject("ERROR_CONFIG_UPDATE", "Failed to set sound configuration: \(error.localizedDescription)")
            }
        }

        // ── Pipeline functions ────────────────────────────────────────────

        AsyncFunction("connectPipeline") { (options: [String: Any], promise: Promise) in
            do {
                let result = try self.pipelineIntegration.connect(options: options)
                promise.resolve(result)
            } catch {
                promise.reject("PIPELINE_CONNECT_ERROR", error.localizedDescription)
            }
        }

        AsyncFunction("pushPipelineAudio") { (options: [String: Any], promise: Promise) in
            do {
                try self.pipelineIntegration.pushAudio(options: options)
                promise.resolve(nil)
            } catch {
                promise.reject("PIPELINE_PUSH_ERROR", error.localizedDescription)
            }
        }

        Function("pushPipelineAudioSync") { (options: [String: Any]) -> Bool in
            return self.pipelineIntegration.pushAudioSync(options: options)
        }

        AsyncFunction("disconnectPipeline") { (promise: Promise) in
            self.pipelineIntegration.disconnect()
            promise.resolve(nil)
        }

        AsyncFunction("invalidatePipelineTurn") { (options: [String: Any], promise: Promise) in
            do {
                try self.pipelineIntegration.invalidateTurn(options: options)
                promise.resolve(nil)
            } catch {
                promise.reject("PIPELINE_INVALIDATE_ERROR", error.localizedDescription)
            }
        }

        Function("getPipelineTelemetry") { () -> [String: Any] in
            return self.pipelineIntegration.getTelemetry()
        }

        Function("getPipelineState") { () -> String in
            return self.pipelineIntegration.getState()
        }
    }

    private func ensureAudioSessionInitialized(settings recordingSettings: RecordingSettings? = nil) throws {
        if self.isAudioSessionInitialized { return }

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            .playAndRecord, mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
        if let settings = recordingSettings {
            try audioSession.setPreferredSampleRate(settings.sampleRate)
            try audioSession.setPreferredIOBufferDuration(1024 / settings.sampleRate)
        }
        try audioSession.setActive(true)
        isAudioSessionInitialized = true
     }

    // used for voice isolation, experimental
    private func promptForMicrophoneModes() {
        guard #available(iOS 15.0, *) else {
            return
        }

        if AVCaptureDevice.preferredMicrophoneMode == .voiceIsolation {
            return
        }

        AVCaptureDevice.showSystemUserInterface(.microphoneModes)
    }

    /// Checks microphone permission and calls the completion handler with the result.
    private func checkMicrophonePermission(completion: @escaping (Bool) -> Void) {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted:
            completion(true)
        case .denied:
            completion(false)
        case .undetermined:
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async {
                    completion(granted)
                }
            }
        @unknown default:
            completion(false)
        }
    }

    func onMicrophoneData(_ microphoneData: Data, _ soundLevel: Float?) {
        let encodedData = microphoneData.base64EncodedString()
        // Construct the event payload similar to Android
        let eventBody: [String: Any] = [
            "fileUri": "",
            "lastEmittedSize": 0,
            "position": 0,
            "encoded": encodedData,
            "deltaSize": 0,
            "totalSize": 0,
            "mimeType": "",
            "soundLevel": soundLevel ?? -160
        ]
        // Emit the event to JavaScript
        sendEvent(audioDataEvent, eventBody)
    }

    func onMicrophoneError(_ error: String, _ errorMessage: String) {
        let eventBody: [String: Any] = [
            "error": error,
            "errorMessage": errorMessage,
            "streamUuid": ""
        ]
        sendEvent(audioDataEvent, eventBody)
    }

    func onDeviceReconnected(_ reason: AVAudioSession.RouteChangeReason) {
        let reasonString: String
        switch reason {
        case .newDeviceAvailable:
            reasonString = "newDeviceAvailable"
        case .oldDeviceUnavailable:
            reasonString = "oldDeviceUnavailable"
        case .unknown, .categoryChange, .override, .wakeFromSleep, .noSuitableRouteForCategory, .routeConfigurationChange:
            reasonString = "unknown"
        @unknown default:
            reasonString = "unknown"
        }

        sendEvent(deviceReconnectedEvent, ["reason": reasonString])
    }

    func onSoundChunkPlayed(_ isFinal: Bool) {
        sendEvent(soundIsPlayedEvent, ["isFinal": isFinal])
    }

    func onSoundStartedPlaying() {
        sendEvent(soundIsStartedEvent)
    }
}
