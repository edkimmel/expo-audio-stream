# API Alignment Audit: Android vs iOS

## HIGH PRIORITY MISALIGNMENTS

### 1. AudioData Event Payload

**Android** (AudioRecorderManager.kt):
```
fileUri, lastEmittedSize, encoded, deltaSize, position, mimeType, soundLevel, totalSize, streamUuid
```

**iOS AudioSessionManager** (ExpoPlayAudioStreamModule.swift):
```
fileUri, lastEmittedSize, position, encoded, deltaSize, totalSize, mimeType
```
- Missing: `streamUuid`, `soundLevel`

**iOS Microphone** (ExpoPlayAudioStreamModule.swift):
```
fileUri, lastEmittedSize (always 0), position (always 0), encoded, deltaSize (always 0), totalSize (always 0), mimeType (""), soundLevel
```
- `lastEmittedSize`, `position`, `deltaSize`, `totalSize` are always hardcoded to 0

### 2. pauseRecording / resumeRecording Signature

| Function | Android | iOS |
|----------|---------|-----|
| pauseRecording | AsyncFunction (Promise) | Function (sync) |
| resumeRecording | AsyncFunction (Promise) | Function (sync) |

Breaks async/await patterns and TypeScript type consistency.

### 3. Frame Size Calculation (Pipeline)

- **Android**: Device HAL-dependent via `AudioTrack.getMinBufferSize` (~2880 samples at 24kHz)
- **iOS**: Fixed 20ms frames via `sampleRate / 50` (480 samples at 24kHz)
- 6x difference in scheduling granularity

### 4. ZOMBIE_DETECTED Event Payload

- **Android**: `{playbackHead: Long, stalledMs: Long}`
- **iOS**: `{stalledMs: Int64}` — missing `playbackHead`

---

## MEDIUM PRIORITY

### 5. Telemetry Key Mismatch

- **Android**: `totalWriteLoops` (write-thread iterations)
- **iOS**: `totalScheduledBuffers` (AVAudioPlayerNode buffers scheduled)

Conceptually equivalent but different key names — JS consumers must branch.

### 6. Sample Rate Handling (Recording)

- **Android**: Respects requested `sampleRate`
- **iOS**: Silently overrides to hardware rate

### 7. iOS Dual Recording Paths

`AudioSessionManager` and `Microphone` both implement recording with very different event payloads. `Microphone` sends zero values for most telemetry fields.

### 8. Platform-Specific Functions

- **Android only**: `setVolume(volume: Double)`
- **iOS only**: `promptMicrophoneModes()`

### 9. toggleSilence

Exposed on `Microphone` path only (iOS). `AudioSessionManager` recording path has no silence toggle.

### 10. Device Reconnected Reason Values

- **iOS** includes `"unknown"` as a catch-all for route change reasons
- **Android** only emits `"newDeviceAvailable"` or `"oldDeviceUnavailable"`

---

## ALIGNED

- All 7 pipeline bridge functions (signatures + options parsing)
- `connectPipeline` return value: `{sampleRate, channelCount, targetBufferMs, frameSizeSamples}`
- Pipeline events (except ZOMBIE_DETECTED): STATE_CHANGED, PLAYBACK_STARTED, ERROR, UNDERRUN, DRAINED, AUDIO_FOCUS_LOST, AUDIO_FOCUS_RESUMED
- `startRecording` return value: `{fileUri, channels, bitDepth, sampleRate, mimeType}`
- `stopRecording` return value: `{fileUri, filename, durationMs, size, channels, bitDepth, sampleRate, mimeType}`
- `toggleSilence` signature (both `Function`, single Bool param)

---

## FULL FUNCTION INVENTORY

| Function | Android | iOS | Aligned? |
|----------|---------|-----|----------|
| destroy | Function | Function | Yes |
| requestPermissionsAsync | AsyncFunction | AsyncFunction | Yes |
| getPermissionsAsync | AsyncFunction | AsyncFunction | Yes |
| startRecording | AsyncFunction | AsyncFunction | Yes |
| stopRecording | AsyncFunction | AsyncFunction | Yes |
| pauseRecording | AsyncFunction | Function | **No** |
| resumeRecording | AsyncFunction | Function | **No** |
| playAudio | AsyncFunction | AsyncFunction | Yes |
| clearPlaybackQueueByTurnId | AsyncFunction | AsyncFunction | Yes |
| pauseAudio | AsyncFunction | AsyncFunction | Yes |
| stopAudio | AsyncFunction | AsyncFunction | Yes |
| listAudioFiles | AsyncFunction | AsyncFunction | Yes |
| playSound | AsyncFunction | AsyncFunction | Yes |
| playWav | — | AsyncFunction | **iOS only** |
| stopSound | AsyncFunction | AsyncFunction | Yes |
| interruptSound | AsyncFunction | AsyncFunction | Yes |
| resumeSound | Function | Function | Yes |
| clearSoundQueueByTurnId | AsyncFunction | AsyncFunction | Yes |
| startMicrophone | — | AsyncFunction | **iOS only** |
| stopMicrophone | — | AsyncFunction | **iOS only** |
| toggleSilence | Function | Function | Yes |
| setSoundConfig | AsyncFunction | AsyncFunction | Yes |
| clearAudioFiles | Function | Function | Yes |
| setVolume | AsyncFunction | — | **Android only** |
| promptMicrophoneModes | — | Function | **iOS only** |
| connectPipeline | AsyncFunction | AsyncFunction | Yes |
| pushPipelineAudio | AsyncFunction | AsyncFunction | Yes |
| pushPipelineAudioSync | Function | Function | Yes |
| disconnectPipeline | AsyncFunction | AsyncFunction | Yes |
| invalidatePipelineTurn | AsyncFunction | AsyncFunction | Yes |
| getPipelineTelemetry | Function | Function | Yes |
| getPipelineState | Function | Function | Yes |

---

## EVENT INVENTORY

| Event | Android | iOS | Payload Aligned? |
|-------|---------|-----|------------------|
| AudioData | Yes | Yes | **No** — iOS missing streamUuid, soundLevel varies |
| SoundChunkPlayed | Yes | Yes | Yes |
| SoundStarted | Yes | Yes | Yes |
| DeviceReconnected | Yes | Yes | Minor — iOS adds "unknown" reason |
| PipelineStateChanged | Yes | Yes | Yes |
| PipelinePlaybackStarted | Yes | Yes | Yes |
| PipelineError | Yes | Yes | Yes |
| PipelineZombieDetected | Yes | Yes | **No** — iOS missing playbackHead |
| PipelineUnderrun | Yes | Yes | Yes |
| PipelineDrained | Yes | Yes | Yes |
| PipelineAudioFocusLost | Yes | Yes | Yes |
| PipelineAudioFocusResumed | Yes | Yes | Yes |
