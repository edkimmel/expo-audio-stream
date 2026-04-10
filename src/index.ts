import type { EventSubscription } from "expo-modules-core";
import ExpoPlayAudioStreamModule from "./ExpoPlayAudioStreamModule";

// Type alias for backwards compatibility
type Subscription = EventSubscription;
import {
  AudioDataEvent,
  AudioRecording,
  RecordingConfig,
  StartRecordingResult,
  SoundConfig,
  PlaybackMode,
  Encoding,
  EncodingTypes,
  FrequencyBands,
  PlaybackModes,
  // Audio jitter buffer types
  IAudioBufferConfig,
  IAudioPlayPayload,
  IAudioFrame,
  BufferHealthState,
  IBufferHealthMetrics,
  IAudioBufferManager,
  IFrameProcessor,
  IQualityMonitor,
  BufferedStreamConfig,
  SmartBufferConfig,
  SmartBufferMode,
  NetworkConditions,
} from "./types";

import {
  addAudioEventListener,
  addSoundChunkPlayedListener,
  AudioEventPayload,
  SoundChunkPlayedEventPayload,
  AudioEvents,
  subscribeToEvent,
  DeviceReconnectedReason,
  DeviceReconnectedEventPayload,
} from "./events";

const SuspendSoundEventTurnId = "suspend-sound-events";

export class ExpoPlayAudioStream {
  /**
   * Destroys the audio stream module, cleaning up all resources.
   * This should be called when the module is no longer needed.
   * It will reset all internal state and release audio resources.
   */
  static async destroy() {
    await ExpoPlayAudioStreamModule.destroy();
  }

  /**
   * @deprecated Use the `Pipeline` class for more efficient audio streaming with better error handling and telemetry.
   * Plays a sound.
   * @param {string} audio - The audio to play.
   * @param {string} turnId - The turn ID.
   * @param {string} [encoding] - The encoding format of the audio data ('pcm_f32le' or 'pcm_s16le').
   * @returns {Promise<void>}
   * @throws {Error} If the sound fails to play.
   */
  static async playSound(
    audio: string,
    turnId: string,
    encoding?: Encoding
  ): Promise<void> {
    try {
      await ExpoPlayAudioStreamModule.playSound(
        audio,
        turnId,
        encoding ?? EncodingTypes.PCM_S16LE
      );
    } catch (error) {
      console.error(error);
      throw new Error(`Failed to enqueue audio: ${error}`);
    }
  }

  /**
   * @deprecated Use the `Pipeline` class for more efficient audio streaming with better error handling and telemetry.
   * Stops the currently playing sound.
   * @returns {Promise<void>}
   * @throws {Error} If the sound fails to stop.
   */
  static async stopSound(): Promise<void> {
    try {
      await ExpoPlayAudioStreamModule.stopSound();
    } catch (error) {
      console.error(error);
      throw new Error(`Failed to stop enqueued audio: ${error}`);
    }
  }

  /**
   * @deprecated Use the `Pipeline` class for more efficient audio streaming with better error handling and telemetry.
   * Clears the sound queue by turn ID.
   * @param {string} turnId - The turn ID.
   * @returns {Promise<void>}
   * @throws {Error} If the sound queue fails to clear.
   */
  static async clearSoundQueueByTurnId(turnId: string): Promise<void> {
    try {
      await ExpoPlayAudioStreamModule.clearSoundQueueByTurnId(turnId);
    } catch (error) {
      console.error(error);
      throw new Error(`Failed to clear sound queue: ${error}`);
    }
  }

  /**
   * Starts microphone streaming.
   * @param {RecordingConfig} recordingConfig - The recording configuration.
   * @returns {Promise<{recordingResult: StartRecordingResult, subscription: Subscription}>} A promise that resolves to an object containing the recording result and a subscription to audio events.
   * @throws {Error} If the recording fails to start.
   */
  static async startMicrophone(recordingConfig: RecordingConfig): Promise<{
    recordingResult: StartRecordingResult;
    subscription?: Subscription;
  }> {
    let subscription: Subscription | undefined;
    try {
      const { onAudioStream, ...options } = recordingConfig;

      if (onAudioStream && typeof onAudioStream == "function") {
        subscription = addAudioEventListener(
          async (event: AudioEventPayload) => {
            const {
              fileUri,
              deltaSize,
              totalSize,
              position,
              encoded,
              soundLevel,
              frequencyBands,
            } = event;
            if (!encoded) {
              console.error(
                `[ExpoPlayAudioStream] Encoded audio data is missing`
              );
              throw new Error("Encoded audio data is missing");
            }
            onAudioStream?.({
              data: encoded,
              position,
              fileUri,
              eventDataSize: deltaSize,
              totalSize,
              soundLevel,
              frequencyBands,
            });
          }
        );
      }

      const result = await ExpoPlayAudioStreamModule.startMicrophone(options);

      return { recordingResult: result, subscription };
    } catch (error) {
      console.error(error);
      subscription?.remove();
      throw new Error(`Failed to start recording: ${error}`);
    }
  }

  /**
   * Stops the current microphone streaming.
   * @returns {Promise<void>}
   * @throws {Error} If the microphone streaming fails to stop.
   */
  static async stopMicrophone(): Promise<AudioRecording | null> {
    try {
      return await ExpoPlayAudioStreamModule.stopMicrophone();
    } catch (error) {
      console.error(error);
      throw new Error(`Failed to stop mic stream: ${error}`);
    }
  }

  /**
   * Subscribes to audio events emitted during recording/streaming.
   * @param onMicrophoneStream - Callback function that will be called when audio data is received.
   * The callback receives an AudioDataEvent containing:
   * - data: Base64 encoded audio data at original sample rate
   * - data16kHz: Optional base64 encoded audio data resampled to 16kHz
   * - position: Current position in the audio stream
   * - fileUri: URI of the recording file
   * - eventDataSize: Size of the current audio data chunk
   * - totalSize: Total size of recorded audio so far
   * @returns {Subscription} A subscription object that can be used to unsubscribe from the events
   * @throws {Error} If encoded audio data is missing from the event
   */
  static subscribeToAudioEvents(
    onMicrophoneStream: (event: AudioDataEvent) => Promise<void>
  ): Subscription {
    return addAudioEventListener(async (event: AudioEventPayload) => {
      const { fileUri, deltaSize, totalSize, position, encoded, soundLevel, frequencyBands } =
        event;
      if (!encoded) {
        console.error(`[ExpoPlayAudioStream] Encoded audio data is missing`);
        throw new Error("Encoded audio data is missing");
      }
      onMicrophoneStream?.({
        data: encoded,
        position,
        fileUri,
        eventDataSize: deltaSize,
        totalSize,
        soundLevel,
        frequencyBands,
      });
    });
  }

  /**
   * Subscribes to events emitted when a sound chunk has finished playing.
   * @param onSoundChunkPlayed - Callback function that will be called when a sound chunk is played.
   * The callback receives a SoundChunkPlayedEventPayload indicating if this was the final chunk.
   * @returns {Subscription} A subscription object that can be used to unsubscribe from the events.
   */
  static subscribeToSoundChunkPlayed(
    onSoundChunkPlayed: (event: SoundChunkPlayedEventPayload) => Promise<void>
  ): Subscription {
    return addSoundChunkPlayedListener(onSoundChunkPlayed);
  }

  /**
   * Subscribes to events emitted by the audio stream module, for advanced use cases.
   * @param eventName - The name of the event to subscribe to.
   * @param onEvent - Callback function that will be called when the event is emitted.
   * @returns {Subscription} A subscription object that can be used to unsubscribe from the events.
   */
  static subscribe<T extends unknown>(
    eventName: string,
    onEvent: (event: T | undefined) => Promise<void>
  ): Subscription {
    return subscribeToEvent(eventName, onEvent);
  }

  /**
   * Sets the sound player configuration.
   * @param {SoundConfig} config - Configuration options for the sound player.
   * @returns {Promise<void>}
   * @throws {Error} If the configuration fails to update.
   */
  static async setSoundConfig(config: SoundConfig): Promise<void> {
    try {
      await ExpoPlayAudioStreamModule.setSoundConfig(config);
    } catch (error) {
      console.error(error);
      throw new Error(`Failed to set sound configuration: ${error}`);
    }
  }

  /**
   * Prompts the user to select the microphone mode.
   * @returns {Promise<void>}
   * @throws {Error} If the microphone mode fails to prompt.
   */
  static promptMicrophoneModes() {
    ExpoPlayAudioStreamModule.promptMicrophoneModes();
  }

  /**
   * Toggles the silence state of the microphone.
   * @returns {Promise<void>}
   * @throws {Error} If the microphone fails to toggle silence.
   */
  static toggleSilence(isSilent: boolean) {
    ExpoPlayAudioStreamModule.toggleSilence(isSilent);
  }

  /**
   * Requests microphone permission from the user.
   * @returns {Promise<{granted: boolean, canAskAgain?: boolean, status?: string}>} A promise that resolves to the permission result.
   */
  static async requestPermissionsAsync(): Promise<{
    granted: boolean;
    canAskAgain?: boolean;
    status?: string;
  }> {
    try {
      return await ExpoPlayAudioStreamModule.requestPermissionsAsync();
    } catch (error) {
      console.error(error);
      throw new Error(`Failed to request permissions: ${error}`);
    }
  }

  /**
   * Gets the current microphone permission status.
   * @returns {Promise<{granted: boolean, canAskAgain?: boolean, status?: string}>} A promise that resolves to the permission status.
   */
  static async getPermissionsAsync(): Promise<{
    granted: boolean;
    canAskAgain?: boolean;
    status?: string;
  }> {
    try {
      return await ExpoPlayAudioStreamModule.getPermissionsAsync();
    } catch (error) {
      console.error(error);
      throw new Error(`Failed to get permissions: ${error}`);
    }
  }
}

export {
  AudioDataEvent,
  SoundChunkPlayedEventPayload,
  DeviceReconnectedReason,
  DeviceReconnectedEventPayload,
  AudioRecording,
  RecordingConfig,
  StartRecordingResult,
  AudioEvents,
  SuspendSoundEventTurnId,
  SoundConfig,
  PlaybackMode,
  Encoding,
  EncodingTypes,
  FrequencyBands,
  PlaybackModes,
  // Audio jitter buffer types
  IAudioBufferConfig,
  IAudioPlayPayload,
  IAudioFrame,
  BufferHealthState,
  IBufferHealthMetrics,
  IAudioBufferManager,
  IFrameProcessor,
  IQualityMonitor,
  BufferedStreamConfig,
  SmartBufferConfig,
  SmartBufferMode,
  NetworkConditions,
};

// Re-export Subscription type for backwards compatibility
export type { EventSubscription } from "expo-modules-core";
export type { Subscription } from "./events";

// Export native audio pipeline V3
export { Pipeline } from "./pipeline";
export type {
  ConnectPipelineOptions,
  ConnectPipelineResult,
  PushPipelineAudioOptions,
  InvalidatePipelineTurnOptions,
  PipelineState,
  PipelineEventMap,
  PipelineEventName,
  PipelineBufferTelemetry,
  PipelineTelemetry,
  PipelineStateChangedEvent,
  PipelinePlaybackStartedEvent,
  PipelineErrorEvent,
  PipelineZombieDetectedEvent,
  PipelineUnderrunEvent,
  PipelineDrainedEvent,
  PipelineAudioFocusLostEvent,
  PipelineAudioFocusResumedEvent,
} from "./pipeline";
