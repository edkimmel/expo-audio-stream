# @edkimmel/expo-audio-stream

Native audio recording and low-latency playback for Expo/React Native. Designed for real-time voice AI applications: microphone capture, chunked PCM playback, and a jitter-buffered native pipeline for streaming audio from AI backends.

## Install

```bash
npx expo install @edkimmel/expo-audio-stream
```

## Quick Start

### Microphone Recording

```typescript
import { ExpoPlayAudioStream } from "@edkimmel/expo-audio-stream";

const { recordingResult, subscription } =
  await ExpoPlayAudioStream.startMicrophone({
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_16bit",
    interval: 100,
    onAudioStream: async (event) => {
      // event.data: base64-encoded PCM chunk
      // event.soundLevel: current mic level (dB)
      sendToBackend(event.data);
    },
  });

// Later:
await ExpoPlayAudioStream.stopMicrophone();
subscription?.remove();
```

### Chunked Playback (playSound)

For playing base64-encoded PCM audio in a queue with turn management:

```typescript
import {
  ExpoPlayAudioStream,
  EncodingTypes,
} from "@edkimmel/expo-audio-stream";

await ExpoPlayAudioStream.setSoundConfig({
  sampleRate: 24000,
  playbackMode: "conversation",
});

// Enqueue chunks as they arrive
await ExpoPlayAudioStream.playSound(
  base64Chunk,
  "turn-1",
  EncodingTypes.PCM_S16LE
);

// Listen for playback completion
const sub = ExpoPlayAudioStream.subscribeToSoundChunkPlayed(async (e) => {
  if (e.isFinal) console.log("Turn finished playing");
});
```

### Native Pipeline (recommended for AI voice streaming)

The `Pipeline` class provides jitter-buffered, low-latency playback with a native write thread. Use this for streaming audio from AI backends over WebSockets.

```typescript
import { Pipeline } from "@edkimmel/expo-audio-stream";

// Connect with desired config
const result = await Pipeline.connect({
  sampleRate: 24000,
  channelCount: 1,
  targetBufferMs: 80,
});

// Subscribe to events
const errorSub = Pipeline.onError((err) => {
  console.error(`Pipeline error: ${err.code} - ${err.message}`);
});

const focusSub = Pipeline.onAudioFocus(({ focused }) => {
  if (!focused) {
    // Another app took audio focus; re-request audio on regain
  }
});

// Hot path: push audio synchronously from WebSocket handler
ws.onmessage = (msg) => {
  Pipeline.pushAudioSync({
    audio: msg.data, // base64 PCM16 LE
    turnId: currentTurnId,
    isFirstChunk: isFirst,
    isLastChunk: isLast,
  });
};

// On new turn, invalidate stale audio
Pipeline.invalidateTurn({ turnId: newTurnId });

// Tear down
await Pipeline.disconnect();
errorSub.remove();
focusSub.remove();
```

## API Reference

### ExpoPlayAudioStream

All methods are static.

#### Lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `destroy()` | `void` | Release all resources. Resets internal state on both platforms. |

#### Permissions

| Method | Returns | Description |
|--------|---------|-------------|
| `requestPermissionsAsync()` | `Promise<PermissionResult>` | Prompt the user for microphone permission. |
| `getPermissionsAsync()` | `Promise<PermissionResult>` | Check the current microphone permission status. |

#### Microphone

| Method | Returns | Description |
|--------|---------|-------------|
| `startMicrophone(config)` | `Promise<{ recordingResult, subscription? }>` | Start mic capture. Audio is delivered as base64 PCM via `onAudioStream` or `subscribeToAudioEvents`. |
| `stopMicrophone()` | `Promise<AudioRecording \| null>` | Stop mic capture and return recording metadata. |
| `toggleSilence(isSilent)` | `void` | Mute/unmute the mic stream without stopping the session. Silenced frames are zero-filled. |
| `promptMicrophoneModes()` | `void` | (iOS only) Show the system voice isolation picker (iOS 15+). |

#### Sound Playback

| Method | Returns | Description |
|--------|---------|-------------|
| `playSound(audio, turnId, encoding?)` | `Promise<void>` | Enqueue a base64 PCM chunk for playback. |
| `stopSound()` | `Promise<void>` | Stop playback and clear the queue. |
| `setSoundConfig(config)` | `Promise<void>` | Update playback sample rate and mode. |

#### Event Subscriptions

| Method | Returns | Description |
|--------|---------|-------------|
| `subscribeToAudioEvents(callback)` | `Subscription` | Receive `AudioDataEvent` during mic capture. |
| `subscribeToSoundChunkPlayed(callback)` | `Subscription` | Notified when a chunk finishes playing. `isFinal` is true when the queue drains. |
| `subscribe(eventName, callback)` | `Subscription` | Generic event listener for any module event. |

### Pipeline

All methods are static. The pipeline manages its own native write thread, jitter buffer, and audio focus.

#### Lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `connect(options?)` | `Promise<ConnectPipelineResult>` | Create the native audio track, jitter buffer, and write thread. Config is immutable per session. |
| `disconnect()` | `Promise<void>` | Tear down the pipeline and release all native resources. |

#### Audio Push

| Method | Returns | Description |
|--------|---------|-------------|
| `pushAudio(options)` | `Promise<void>` | Push base64 PCM16 LE audio (async, with error propagation). |
| `pushAudioSync(options)` | `boolean` | Push audio synchronously. No Promise overhead -- use in WebSocket `onmessage` for minimum latency. Returns `false` on failure. |

#### Turn Management

| Method | Returns | Description |
|--------|---------|-------------|
| `invalidateTurn(options)` | `Promise<void>` | Discard buffered audio for the old turn. The jitter buffer is reset. |

#### State & Telemetry

| Method | Returns | Description |
|--------|---------|-------------|
| `getState()` | `PipelineState` | Current state: `idle`, `connecting`, `streaming`, `draining`, or `error`. |
| `getTelemetry()` | `PipelineTelemetry` | Snapshot of buffer levels, push counts, write loops, underruns, etc. |

#### Event Subscriptions

| Method | Returns | Description |
|--------|---------|-------------|
| `subscribe(eventName, listener)` | `EventSubscription` | Type-safe subscription to any pipeline event. |
| `onError(listener)` | `{ remove }` | Convenience: handles both `PipelineError` and `PipelineZombieDetected`. |
| `onAudioFocus(listener)` | `{ remove }` | Convenience: `{ focused: true/false }` on audio focus changes. |

## Configuration Types

### RecordingConfig

```typescript
interface RecordingConfig {
  sampleRate?: 16000 | 24000 | 44100 | 48000;
  channels?: 1 | 2;
  encoding?: "pcm_32bit" | "pcm_16bit" | "pcm_8bit";
  interval?: number; // ms between audio data emissions (default 1000)
  onAudioStream?: (event: AudioDataEvent) => Promise<void>;
}
```

### SoundConfig

```typescript
interface SoundConfig {
  sampleRate?: 16000 | 24000 | 44100 | 48000;
  playbackMode?: "regular" | "voiceProcessing" | "conversation";
  useDefault?: boolean; // reset to defaults
}
```

### ConnectPipelineOptions

```typescript
interface ConnectPipelineOptions {
  sampleRate?: number;     // default 24000
  channelCount?: number;   // default 1 (mono)
  targetBufferMs?: number; // ms to buffer before priming gate opens (default 80)
}
```

### PushPipelineAudioOptions

```typescript
interface PushPipelineAudioOptions {
  audio: string;           // base64-encoded PCM 16-bit signed LE
  turnId: string;
  isFirstChunk?: boolean;  // resets jitter buffer
  isLastChunk?: boolean;   // marks end-of-stream, begins drain
}
```

## Events

### Core Events

| Event | Payload | Description |
|-------|---------|-------------|
| `AudioData` | `{ encoded, position, deltaSize, totalSize, soundLevel, ... }` | Emitted during mic capture at the configured interval. |
| `SoundChunkPlayed` | `{ isFinal: boolean }` | A queued chunk finished playing. `isFinal` when the queue is empty. |
| `SoundStarted` | (none) | Playback began for a new turn. |
| `DeviceReconnected` | `{ reason }` | Audio route changed (headphones, Bluetooth, etc). |

### Pipeline Events

| Event | Payload | Description |
|-------|---------|-------------|
| `PipelineStateChanged` | `{ state }` | Pipeline state transition. |
| `PipelinePlaybackStarted` | `{ turnId }` | Priming gate opened, audio is now audible. |
| `PipelineError` | `{ code, message }` | Non-recoverable error. |
| `PipelineZombieDetected` | `{ playbackHead, stalledMs }` | Audio track stalled. |
| `PipelineUnderrun` | `{ count }` | Jitter buffer underrun (silence inserted). |
| `PipelineDrained` | `{ turnId }` | All buffered audio for the turn has been played. |
| `PipelineAudioFocusLost` | (empty) | Another app took audio focus. |
| `PipelineAudioFocusResumed` | (empty) | Audio focus regained. |

## Constants

```typescript
import {
  EncodingTypes,           // { PCM_F32LE: "pcm_f32le", PCM_S16LE: "pcm_s16le" }
  PlaybackModes,           // { REGULAR, VOICE_PROCESSING, CONVERSATION }
  AudioEvents,             // { AudioData, SoundChunkPlayed, SoundStarted, DeviceReconnected }
  SuspendSoundEventTurnId, // "suspend-sound-events" -- suppresses playback events
} from "@edkimmel/expo-audio-stream";
```

## Platform Notes

### iOS

- Uses `AVAudioEngine` with `AVAudioPlayerNode` for sound playback and pipeline audio.
- Microphone capture via `AVAudioEngine.inputNode` tap.
- Audio session configured as `.playAndRecord` with `.voiceChat` mode.
- Voice processing (AEC/noise reduction) available via `voiceProcessing` and `conversation` playback modes.
- `promptMicrophoneModes()` exposes the iOS 15+ system voice isolation picker.

### Android

- Uses `AudioTrack` (float PCM, `MODE_STREAM`) for sound playback.
- Microphone capture via `AudioRecord` with `VOICE_RECOGNITION` source for far-field mic gain.
- AEC, noise suppression, and AGC applied via `AudioEffectsManager`.

## License

MIT
