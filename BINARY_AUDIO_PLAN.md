# Feature Plan: Binary PCM and Opus Support

Status: **proposal** — no implementation yet.

This document proposes adding (1) binary PCM transport across the Expo bridge and
(2) Opus encode/decode, on both the microphone capture path and the Pipeline
playback path. Everything here is designed to be **backwards compatible on the
Expo bridge**: no existing native function signature, event name, or event
payload key changes type or meaning. New behavior is additive and opt-in.

---

## 1. Motivation

Today every audio chunk crosses the JS bridge as a **base64 string**, in both
directions:

- Mic capture: PCM16 bytes → `base64EncodedString()` → `sendEvent("AudioData", { encoded })`
  (`ios/ExpoPlayAudioStreamModule.swift:378-398`, `android/.../AudioRecorderManager.kt:553-596`).
- Pipeline playback: JS pushes `{ audio: <base64> }` → native base64-decodes →
  Int16 samples → jitter buffer (`ios/AudioPipeline.swift:457-469`,
  `android/.../pipeline/AudioPipeline.kt:430-441`).

Costs of the status quo:

- **+33% payload size** on every bridge crossing and (for uncompressed sockets)
  on the wire when the app forwards chunks verbatim.
- **String allocation on the JS heap** for every chunk, plus base64
  encode/decode CPU on the hot path.
- **No compressed codec**: 24 kHz mono PCM16 is 384 kbps. Opus voice is
  ~24–32 kbps — a ~15x bandwidth reduction — and is what real-time voice
  backends (e.g. xAI's realtime API, one Opus packet per WebSocket frame)
  speak natively.

Both native implementations are already fully binary internally — base64 exists
*only* at the bridge crossing. The jitter buffers (`[[Int16]]` /
`ArrayDeque<ShortArray>`), renderers (AVAudioPlayerNode `scheduleBuffer`,
`AudioTrack.write`), resamplers, and analyzers need **no changes** for any of
this.

### Non-goals / explicitly out of scope

- **Echo cancellation changes.** Hardware/OS AEC is already active on both
  platforms (iOS: `setVoiceProcessingEnabled(true)` on the input node,
  `ios/SharedAudioEngine.swift:157-159`; Android: `VOICE_COMMUNICATION` source +
  `AcousticEchoCanceler` attached before recording, plus
  `USAGE_VOICE_COMMUNICATION` on the playback AudioTrack so it feeds the HAL
  echo reference). AEC operates on raw PCM at the capture point, *before* any
  encoder — codec work is fully orthogonal to it. Note that WebRTC does not
  hardware-accelerate Opus either; it ships software libopus. The
  hardware-accelerated part of WebRTC's audio stack is the platform AEC, which
  this module already uses.
- **WebSocket transport / protocol framing to specific backends.** Adapting to
  a backend's message framing (e.g. one packet per WS frame) is the app's
  transport layer's job. The module exposes a batch-oriented contract that a
  transport adapter can trivially split/merge (see §4.3).
- Changing the legacy `playSound` path — it was removed in `bf1b7be`; the
  Pipeline is the only playback path.

---

## 2. Backwards-compatibility ground rules

These rules govern every change below. They exist because event payloads and
untyped bridge dictionaries are consumed by existing apps we cannot coordinate
with.

1. **Never change the type or meaning of an existing event payload key.**
   `AudioData.encoded` remains an optional base64 `string`. Binary delivery
   uses a **new** key, and only when the app opts in.
2. **Never change an existing native function's argument shape.**
   `pushPipelineAudio(Sync)` today receives an untyped dictionary and reads
   `options["audio"] as? String` (`ios/PipelineIntegration.swift:94-126`,
   `android/.../pipeline/PipelineIntegration.kt:162-200`). Typed-array
   conversion in expo-modules-core is only well-defined for **typed argument
   positions**, not for values inside untyped `[String: Any]` /
   `ReadableMap` dictionaries — so binary push gets **new, separately named
   native functions** with typed positional args rather than a widened dict
   field.
3. **All new config fields are optional with defaults preserving today's
   behavior.** Omitting them yields byte-for-byte the current bridge traffic.
4. **TS-only unions may widen, but only behind opt-in.** E.g.
   `AudioDataEvent.data` remains a `string` unless the app sets the new
   binary flag; the type-level union widens to document the opt-in variant.
5. **Version-gate Android binary events.** Binary payloads in `sendEvent` on
   Android require the expo-modules-core fix from expo/expo#32945 (a Kotlin
   `ByteArray`/typed array in an event previously arrived in JS as a string
   ID; fixed in the 2.x line this repo resolves — 2.5.0 per `yarn.lock`).
   The module must fall back to base64 (and surface a warning) if the host
   app's expo-modules-core predates the fix, rather than emitting garbage.

---

## 3. Feature 1 — Binary PCM over the bridge

### 3.1 Pipeline push (JS → native)

**Public TS API** (shape unchanged, `audio` union widens):

```ts
interface PushAudioOptions {
  audio: string | Uint8Array;   // was: string (base64 PCM16 LE)
  turnId: string;
  isFirstChunk?: boolean;
  isLastChunk?: boolean;
}
Pipeline.pushAudio(options): Promise<void>
Pipeline.pushAudioSync(options): boolean
```

`src/pipeline/index.ts` dispatches on `options.audio instanceof Uint8Array`:

- `string` → existing `pushPipelineAudio(Sync)` native functions, untouched.
- `Uint8Array` → **new** native functions with typed positional args:

```
pushPipelineAudioBinary(audio: Uint8Array, turnId: String,
                        isFirstChunk: Bool, isLastChunk: Bool)  // AsyncFunction
pushPipelineAudioBinarySync(...) -> Bool                        // Function (sync JSI)
```

Native side: both functions call the existing `AudioPipeline.pushAudio`
internals, skipping only the base64 decode — i.e. the branch point is
`ios/AudioPipeline.swift:457` / `android/.../pipeline/AudioPipeline.kt:430`.
Refactor `pushAudio(base64Audio:...)` into a thin wrapper around a new
`pushAudio(bytes:...)` so turn handling, telemetry, and end-of-stream logic
stay single-sourced.

**Copy semantics:** a JSI-backed `Uint8Array`'s buffer is only guaranteed valid
during the synchronous call. Both implementations already copy into
`[Int16]`/`ShortArray` inside the call before returning, so this holds — but it
must be stated as an invariant in the code (no retaining the incoming buffer).

**Perf side-fix (iOS):** the existing byte→Int16 conversion is a per-sample
Swift loop (`ios/AudioPipeline.swift:464-469`). Replace with a bulk
`withMemoryRebound`/`memcpy` copy (PCM16 LE matches the platform's native
layout on all supported targets). Benefits the base64 path too.

### 3.2 Mic capture events (native → JS)

**Opt-in flag on `RecordingConfig`:**

```ts
interface RecordingConfig {
  // ...existing fields...
  binaryData?: boolean;   // default false — payload format is unchanged unless set
}
```

Behavior when `binaryData: true`:

- Native emits the `AudioData` event with a **new** payload key `bytes`
  (`Data` on iOS, `ByteArray` on Android → `Uint8Array` in JS) and **omits**
  `encoded`. All other keys (`deltaSize`, `totalSize`, `position`,
  `soundLevel`, `frequencyBands`, `streamUuid`, …) are unchanged.
- The TS layer (`src/index.ts` mapping in `startMicrophone`, and
  `src/events.ts` `AudioEventPayload`) maps `bytes ?? encoded` into
  `AudioDataEvent.data`. Public type becomes:

```ts
interface AudioDataEvent {
  data: string | Uint8Array;  // string unless binaryData: true
  // ...
}
```

  (The existing never-produced `Float32Array` variant in
  `src/types.ts:110-120` / `src/events.ts:14` is vestigial; keep it in the
  union or deprecate it in a comment — do not repurpose it.)

- When `binaryData` is false or absent: **zero change**, `encoded` base64 as
  today.

**Android version gate (rule 5):** at `startMicrophone` time, if
`binaryData: true` and the runtime expo-modules-core lacks the #32945 fix,
log a warning and fall back to base64 (`encoded`). Detection can be a
one-time round-trip self-test or a version check; decide during
implementation (see Open Questions).

**Emit sites to touch:** `ios/ExpoPlayAudioStreamModule.swift:377-399`
(`onMicrophoneData`), `android/.../AudioRecorderManager.kt:542-597`
(`emitAudioData`). The delivery plumbing (`MicrophoneDataDelegate`,
`EventSender`) is format-agnostic and unchanged.

**Rejected alternative — pull model:** event carries metadata only; JS calls a
sync `readMicChunk(): Uint8Array` draining a native ring buffer. Strictly more
moving parts and an extra bridge call per chunk; only worth revisiting if
binary event payloads misbehave on some Expo version in testing.

---

## 4. Feature 2 — Opus

### 4.1 Codec engine: vendored libopus on both platforms

Recommendation: **vendor libopus** (BSD-3; ~300 KB compiled) rather than
platform codecs.

| Option | Verdict |
|---|---|
| libopus (vendored) | ✅ Identical behavior both platforms; synchronous per-packet encode/decode (no codec-queue latency); exposes PLC (`opus_decode(NULL, …)`) and in-band FEC for future jitter-buffer upgrades. This is what WebRTC itself ships. |
| iOS `AVAudioConverter` + `kAudioFormatOpus` | Decode works but packet-loss handling is weak/undocumented; **encode is not reliably supported**. Would still need libopus for mic encode → two decoder stacks. |
| Android `MediaCodec` (`audio/opus`) | Software C2 component anyway (no hardware Opus exists on phones); async queue adds latency and CSD/header setup ceremony; encoder only ≥ API 29. |

Packaging: iOS — compile from source in the podspec (or a prebuilt
xcframework checked into the repo); Android — libopus via CMake/NDK in
`android/build.gradle` (avoid Java ports like Concentus; they are far slower
than NEON-optimized C). Exact mechanism is an implementation-time decision
(see Open Questions).

Codec settings (voice streaming defaults): 20 ms frames, mono,
`OPUS_APPLICATION_VOIP`, target bitrate ~24–32 kbps, FEC off initially.
Supported sample rates: Opus natively runs at 8/12/16/24/48 kHz — the module's
existing 16000/24000/48000 rates map directly; **44100 is not an Opus rate**
and must be rejected with a typed error when a codec is configured.

### 4.2 Packet framing: `expo-audio-stream packet batch v1`

Opus is packet-oriented — packet boundaries must survive the bridge. All Opus
payloads (both directions) use one framing:

```
batch      := packet+
packet     := u16le length ‖ length bytes of one Opus packet
```

- A batch of **one** packet is valid and is the expected downlink case
  (e.g. one packet per WebSocket frame → one push per `onmessage`).
- Max packet size accepted: 4000 bytes (larger than any sane voice packet;
  reject batch with `DECODE_ERROR` beyond it).
- PCM payloads (binary or base64) remain **raw unframed** PCM16 LE bytes,
  exactly as today.

### 4.3 Bridge cadence is unchanged — framing lives below, batching above

20 ms is the **codec** frame size, not the bridge cadence:

- **Mic:** the existing `interval` config keeps setting the event rate. Native
  encodes each interval's audio into ⌊interval/20 ms⌋ packets and emits them
  as **one batch per event**. `interval` becomes the app's mic-to-server
  latency knob (e.g. 40–60 ms for conversational voice ⇒ 2–3 packets/event) —
  never a 50 Hz event stream.
- **Playback:** push cadence stays whatever the app's socket delivers. A
  transport adapter for a one-packet-per-WS-frame backend simply pushes each
  message as a single-packet batch (~50 sync JSI calls/sec is fine — the
  historical fear of 50 Hz bridge traffic was the async bridge + base64
  strings, which this is not). A backend that batches maps 1:1 onto a
  multi-packet batch.

### 4.4 Pipeline decode (playback)

**Config — `connect`-time**, since pipeline config is already immutable per
session (additive optional field on the connect options record):

```ts
Pipeline.connect({
  sampleRate: 24000,
  channelCount: 1,
  codec?: 'pcm_s16le' | 'opus',   // default 'pcm_s16le' — today's behavior
  ...
})
```

Data path: bridge bytes (binary or base64 — codec and transport encoding are
orthogonal, all four combinations work) → parse batch framing → libopus
decode per packet → Int16 samples → `buf.write(...)`. Insertion point is the
same choke point as §3.1 (`ios/AudioPipeline.swift:457` /
`AudioPipeline.kt:430`). Jitter buffer, priming, turn invalidation
(`buf.reset()` + `opus_decoder_ctl(OPUS_RESET_STATE)` on turn boundary),
resampling, and rendering are untouched.

Errors: malformed framing or failed decode → existing `DECODE_ERROR` pipeline
error event (`NATIVE_EVENTS.md:200`), drop the batch, keep streaming.

### 4.5 Mic encode (capture)

**Config** — widen the existing encoding union (additive):

```ts
type RecordingEncodingType = 'pcm_32bit' | 'pcm_16bit' | 'pcm_8bit' | 'opus';
```

Insertion point: after the existing capture → Float32→Int16 (iOS) / gain +
silence processing (Android), immediately before the emit sites in §3.2.
Native accumulates PCM into 20 ms frames (carrying remainder samples across
intervals so nothing is dropped when `interval` isn't a multiple of 20 ms),
encodes, and emits the interval's packets as one batch.

Event payload with `encoding: 'opus'`:

- `bytes` (with `binaryData: true`) or `encoded` (base64) carries the **batch**,
  not raw PCM.
- New additive key `codec: 'opus'` in the payload so consumers can
  distinguish without out-of-band state; `mimeType` reports `"audio/opus"`.
  (`mimeType` is informational today — `""` on iOS, `"audio/wav"` on Android,
  while actually emitting headerless PCM — but changing its *value* for a new
  opt-in mode is fair game; its *type* stays `string`.)
- `soundLevel` / `frequencyBands` / `position` / size counters keep working:
  they are computed from PCM **before** encoding, exactly where they are
  today. Size fields (`deltaSize`, `totalSize`) count **payload bytes as
  delivered** (i.e. encoded bytes), which matches their current meaning of
  "bytes in this event".

Android already maps an `"opus"` encoding string in
`AudioDataEncoder.kt:95-107` (recording-format descriptor only, currently
unreachable from TS) — that branch gets superseded by real encoder wiring;
`AudioRecord` capture stays PCM16 (`ENCODING_OPUS` on `AudioRecord` is not
how this works — capture PCM, encode in software).

Silence handling (`toggleSilence`): encode the zero-filled frames rather than
special-casing — keeps packet cadence and decoder state continuous.

---

## 5. Known defects to fix alongside (pre-existing, low risk)

These touch the same files and should land first (Phase 0):

1. **iOS mic config key mismatch.** iOS reads `options["channelConfig"]` /
   `options["audioFormat"]` (`ios/ExpoPlayAudioStreamModule.swift:109-110`)
   but the TS layer sends `channels` / `encoding` (`src/types.ts:124-125`) —
   so those fields are silently ignored on iOS today. Read the correct keys
   (keep reading legacy keys as fallback, per rule 1's spirit).
2. **iOS per-sample byte→Int16 loop** (`ios/AudioPipeline.swift:464-469`) →
   bulk copy (§3.1).
3. **Stale docs.** README still documents the deleted `playSound` path
   (README.md:41-70, 147-149, 317) and misstates the Android track as
   "float PCM" (README.md:328 — it is `ENCODING_PCM_16BIT`,
   `AudioPipeline.kt:273-277`).

---

## 6. Implementation phases

Each phase is independently shippable and independently revertible.

| Phase | Scope | Files (primary) |
|---|---|---|
| **0** | Defect fixes above; no behavior change for correct configs | `ios/ExpoPlayAudioStreamModule.swift`, `ios/AudioPipeline.swift`, `README.md` |
| **1** | Binary PCM pipeline push: new `pushPipelineAudioBinary(Sync)` natives, TS dispatch on `Uint8Array` | `src/pipeline/index.ts`, `src/pipeline/types.ts`, `ios/ExpoPlayAudioStreamModule.swift`, `ios/PipelineIntegration.swift`, `ios/AudioPipeline.swift`, `ExpoPlayAudioStreamModule.kt`, `PipelineIntegration.kt`, `AudioPipeline.kt` |
| **2** | Binary PCM mic events: `binaryData` flag, `bytes` payload key, Android version gate | `src/types.ts`, `src/events.ts`, `src/index.ts`, `ios/ExpoPlayAudioStreamModule.swift`, `ios/RecordingSettings.swift`, `AudioRecorderManager.kt`, `RecordingConfig.kt` |
| **3** | libopus vendoring + Pipeline Opus decode (`codec` connect option, batch framing) | `ios/ExpoPlayAudioStream.podspec`, `android/build.gradle` (+CMake), new `OpusCodec.swift` / `OpusCodec.kt`, `AudioPipeline.swift/kt`, `src/pipeline/types.ts` |
| **4** | Mic Opus encode (`encoding: 'opus'`, 20 ms framing/accumulator, `codec` payload key) | `Microphone.swift`, `AudioRecorderManager.kt`, `AudioDataEncoder.kt`, `RecordingConfig.kt`, `src/types.ts` |
| **5** (future) | PLC/FEC in jitter-buffer underrun path; per-packet loss flags; possible native transport | — |

Suggested order 1 → 2 → 3 → 4: each PCM phase de-risks the bridge mechanics
its Opus counterpart depends on.

---

## 7. Testing plan

- **Round-trip unit-level checks (native):** PCM16 fixture → batch-frame →
  encode → decode → correlate against input (Opus is lossy; assert energy /
  cross-correlation, not byte equality). Framing parser fuzz: truncated
  length prefix, zero-length packet, oversize packet.
- **Bridge compatibility matrix (example app):** `{base64, binary} ×
  {pcm, opus} × {mic, pipeline} × {iOS, Android}`, plus the two regression
  cases that must be byte-identical to today: default mic config, string
  `pushAudio`.
- **Back-compat assertion:** a consumer written against the current typings
  (reads `event.data` as string, pushes base64) compiles and runs unchanged
  against the new build with no config changes.
- **Android version gate:** verify fallback path against an older
  expo-modules-core (pre-#32945) host app.
- **AEC sanity:** conversation-mode loopback test on device confirming echo
  cancellation is unaffected with `codec: 'opus'` on the pipeline + Opus mic
  encode (it should be — AEC sits before encode/after decode — this test
  exists to catch accidental graph/session changes).
- **Latency/perf spot checks:** telemetry (`getTelemetry`) before/after on a
  50 pushes/sec single-packet stream; mic event cadence at
  `interval: 40/60/100` with Opus.

---

## 8. Open questions

1. **libopus packaging** — iOS: build-from-source in podspec vs. checked-in
   xcframework; Android: NDK/CMake build vs. prebuilt `.aar`. Decide at Phase
   3 start based on maintenance appetite (source build tracks upstream more
   easily; prebuilt keeps consumer build times down).
2. **Android #32945 detection** — expo-modules-core doesn't expose a clean
   runtime version API; options are a build-time peer-dependency floor
   (simplest: require `expo-modules-core >= 2.5.0` and document it) vs. a
   runtime self-test. Leaning: dependency floor + fallback flag.
3. **`encoded` + Opus without `binaryData`** — supported per §4.5 (base64 of
   the batch) for consumers that want Opus but can't take binary events yet.
   Confirm there's a real consumer for this before writing tests for the
   combination; if not, gate `encoding: 'opus'` on `binaryData: true` and
   fail fast with a typed error.
4. **Stereo Opus** — mic path is effectively mono today (iOS taps mono
   explicitly). Propose shipping Opus as mono-only initially and rejecting
   `channels: 2` + `opus` with a typed error.

---

## 9. References

- expo-modules-core typed arrays: function args/returns supported both
  platforms; Android event-payload fix: expo/expo#29566 (bug),
  expo/expo#32945 (fix).
- Apple Opus: `kAudioFormatOpus` (CoreAudioTypes); AVAudioConverter Opus
  decode discussion, Apple Developer Forums thread 127317.
- Opus: RFC 6716; libopus (BSD-3), xiph.org/opus.
- Prior analysis of both native paths (capture and playback hop-by-hop maps)
  was done against commit `ac3e6e7`; file:line references above refer to that
  revision.
