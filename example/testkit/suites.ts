/**
 * E2E self-test suites, exercised by Maestro (see .maestro/) or manually
 * from the example app's home screen.
 *
 * Suite variations map onto the test plan in BINARY_AUDIO_PLAN.md §7.1:
 * base64 push (regression), binary push (Phase 1), edge cases, and mic
 * capture. Assertions use only JS-observable state (telemetry, events,
 * push results) so they run identically on emulators and real devices.
 */

import { ExpoPlayAudioStream, Pipeline } from "@edkimmel/expo-audio-stream";
import type {
  AudioDataEvent,
  PipelineEventMap,
  PipelineEventName,
} from "@edkimmel/expo-audio-stream";
import {
  Suite,
  assert,
  assertEqual,
  base64Encode,
  sineWavePcm16,
  sleep,
  waitFor,
} from "./runner";

const SAMPLE_RATE = 24000;
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000; // mono PCM16

/** Subscribe before acting; await the matching event with a timeout. */
function expectEvent<K extends PipelineEventName>(
  eventName: K,
  predicate: (e: PipelineEventMap[K]) => boolean = () => true,
  timeoutMs = 20000
): Promise<PipelineEventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.remove();
      reject(new Error(`timeout waiting for ${eventName}`));
    }, timeoutMs);
    const sub = Pipeline.subscribe(eventName, async (e) => {
      if (predicate(e)) {
        clearTimeout(timer);
        sub.remove();
        resolve(e);
      }
    });
  });
}

async function withPipeline(
  fn: (connectResult: {
    sampleRate: number;
    channelCount: number;
    targetBufferMs: number;
    frameSizeSamples: number;
  }) => Promise<void>
): Promise<void> {
  await Pipeline.disconnect().catch(() => {});
  const result = await Pipeline.connect({
    sampleRate: SAMPLE_RATE,
    channelCount: 1,
    targetBufferMs: 80,
    audioMode: "mixWithOthers",
  });
  try {
    await fn(result);
  } finally {
    await Pipeline.disconnect().catch(() => {});
  }
}

/** Push `chunks` under one turn, first/last flags set, asserting each push. */
function pushChunksSync(
  chunks: Array<string | Uint8Array>,
  turnId: string
): void {
  chunks.forEach((audio, i) => {
    const ok = Pipeline.pushAudioSync({
      audio,
      turnId,
      isFirstChunk: i === 0,
      isLastChunk: i === chunks.length - 1,
    });
    assert(ok, `pushAudioSync chunk ${i + 1}/${chunks.length} returned false`);
  });
}

function totalPushBytes(): number {
  return Pipeline.getTelemetry().totalPushBytes;
}

// ── Suite: pipeline PCM via base64 (regression baseline) ────────────────────

const pipelineBase64: Suite = {
  id: "pipeline-base64",
  title: "Pipeline PCM (base64)",
  description: "Legacy base64 string push path — the pre-binary baseline.",
  tests: [
    {
      name: "connect reports session config and sane latency",
      run: () =>
        withPipeline(async (result) => {
          assertEqual(result.sampleRate, SAMPLE_RATE, "sampleRate");
          assertEqual(result.channelCount, 1, "channelCount");
          assert(result.frameSizeSamples > 0, "frameSizeSamples must be > 0");
          assert(Pipeline.getOutputLatencyMs() >= 0, "latency must be >= 0");
        }),
    },
    {
      name: "one second of sine drains through the pipeline",
      run: () =>
        withPipeline(async () => {
          const turnId = "b64-turn";
          const before = totalPushBytes();
          const started = expectEvent(
            "PipelinePlaybackStarted",
            (e) => e.turnId === turnId
          );
          const drained = expectEvent(
            "PipelineDrained",
            (e) => e.turnId === turnId
          );
          const chunks = Array.from({ length: 10 }, () =>
            base64Encode(sineWavePcm16(SAMPLE_RATE, CHUNK_MS))
          );
          pushChunksSync(chunks, turnId);
          await started;
          await drained;
          assertEqual(
            totalPushBytes() - before,
            CHUNK_BYTES * 10,
            "totalPushBytes delta"
          );
        }),
    },
  ],
};

// ── Suite: pipeline PCM via binary Uint8Array (Phase 1) ─────────────────────

const pipelineBinary: Suite = {
  id: "pipeline-binary",
  title: "Pipeline PCM (binary)",
  description: "Uint8Array push path — no base64 round-trip.",
  tests: [
    {
      name: "one second of sine drains via pushAudioSync(Uint8Array)",
      run: () =>
        withPipeline(async () => {
          const turnId = "bin-turn";
          const before = totalPushBytes();
          const drained = expectEvent(
            "PipelineDrained",
            (e) => e.turnId === turnId
          );
          const chunks = Array.from({ length: 10 }, () =>
            sineWavePcm16(SAMPLE_RATE, CHUNK_MS)
          );
          pushChunksSync(chunks, turnId);
          await drained;
          assertEqual(
            totalPushBytes() - before,
            CHUNK_BYTES * 10,
            "totalPushBytes delta"
          );
        }),
    },
    {
      name: "async pushAudio(Uint8Array) also reaches the buffer",
      run: () =>
        withPipeline(async () => {
          const turnId = "bin-async-turn";
          const before = totalPushBytes();
          const drained = expectEvent(
            "PipelineDrained",
            (e) => e.turnId === turnId
          );
          await Pipeline.pushAudio({
            audio: sineWavePcm16(SAMPLE_RATE, CHUNK_MS),
            turnId,
            isFirstChunk: true,
          });
          await Pipeline.pushAudio({
            audio: sineWavePcm16(SAMPLE_RATE, CHUNK_MS),
            turnId,
            isLastChunk: true,
          });
          await drained;
          assertEqual(
            totalPushBytes() - before,
            CHUNK_BYTES * 2,
            "totalPushBytes delta"
          );
        }),
    },
    {
      name: "binary and base64 chunks interleave in one turn",
      run: () =>
        withPipeline(async () => {
          const turnId = "mixed-turn";
          const before = totalPushBytes();
          const drained = expectEvent(
            "PipelineDrained",
            (e) => e.turnId === turnId
          );
          const pcm = sineWavePcm16(SAMPLE_RATE, CHUNK_MS);
          pushChunksSync([pcm, base64Encode(pcm), pcm, base64Encode(pcm)], turnId);
          await drained;
          assertEqual(
            totalPushBytes() - before,
            CHUNK_BYTES * 4,
            "totalPushBytes delta"
          );
        }),
    },
  ],
};

// ── Suite: edge cases ───────────────────────────────────────────────────────

const pipelineEdge: Suite = {
  id: "pipeline-edge",
  title: "Pipeline edge cases",
  description: "Boundary and misuse behavior on both push paths.",
  tests: [
    {
      name: "pushes before connect fail cleanly",
      run: async () => {
        await Pipeline.disconnect().catch(() => {});
        assertEqual(
          Pipeline.pushAudioSync({ audio: "QUJD", turnId: "t" }),
          false,
          "sync base64 push before connect"
        );
        assertEqual(
          Pipeline.pushAudioSync({
            audio: new Uint8Array([1, 0]),
            turnId: "t",
          }),
          false,
          "sync binary push before connect"
        );
        let rejected = false;
        await Pipeline.pushAudio({
          audio: new Uint8Array([1, 0]),
          turnId: "t",
        }).catch(() => {
          rejected = true;
        });
        assert(rejected, "async binary push before connect must reject");
      },
    },
    {
      name: "empty and odd-length binary pushes are accepted",
      run: () =>
        withPipeline(async () => {
          const turnId = "edge-turn";
          const drained = expectEvent(
            "PipelineDrained",
            (e) => e.turnId === turnId
          );
          const ok1 = Pipeline.pushAudioSync({
            audio: new Uint8Array(0),
            turnId,
            isFirstChunk: true,
          });
          assert(ok1, "empty push returned false");
          const odd = sineWavePcm16(SAMPLE_RATE, CHUNK_MS);
          const ok2 = Pipeline.pushAudioSync({
            audio: odd.subarray(0, odd.byteLength - 1), // odd byte count
            turnId,
            isLastChunk: true,
          });
          assert(ok2, "odd-length push returned false");
          await drained;
        }),
    },
    {
      name: "subarray view pushes exactly the view's bytes",
      run: () =>
        withPipeline(async () => {
          const turnId = "view-turn";
          const before = totalPushBytes();
          const drained = expectEvent(
            "PipelineDrained",
            (e) => e.turnId === turnId
          );
          const backing = new Uint8Array(CHUNK_BYTES + 64);
          backing.set(sineWavePcm16(SAMPLE_RATE, CHUNK_MS), 32);
          const view = backing.subarray(32, 32 + CHUNK_BYTES);
          assertEqual(view.byteOffset, 32, "view byteOffset");
          pushChunksSync([view], turnId);
          await drained;
          assertEqual(
            totalPushBytes() - before,
            CHUNK_BYTES,
            "totalPushBytes delta"
          );
        }),
    },
    {
      name: "buffer may be reused immediately after a sync push",
      run: () =>
        withPipeline(async () => {
          const turnId = "reuse-turn";
          const before = totalPushBytes();
          const drained = expectEvent(
            "PipelineDrained",
            (e) => e.turnId === turnId
          );
          const buffer = sineWavePcm16(SAMPLE_RATE, CHUNK_MS);
          const ok1 = Pipeline.pushAudioSync({
            audio: buffer,
            turnId,
            isFirstChunk: true,
          });
          assert(ok1, "first push failed");
          buffer.fill(0); // overwrite immediately — native must have copied
          const ok2 = Pipeline.pushAudioSync({
            audio: buffer,
            turnId,
            isLastChunk: true,
          });
          assert(ok2, "second push failed");
          await drained;
          assertEqual(
            totalPushBytes() - before,
            CHUNK_BYTES * 2,
            "totalPushBytes delta"
          );
        }),
    },
    {
      name: "invalidateTurn discards the pending turn",
      run: () =>
        withPipeline(async () => {
          // Start an unfinished turn A (no isLastChunk), invalidate to B,
          // then B must drain normally.
          const ok = Pipeline.pushAudioSync({
            audio: sineWavePcm16(SAMPLE_RATE, CHUNK_MS),
            turnId: "turn-a",
            isFirstChunk: true,
          });
          assert(ok, "turn-a push failed");
          await Pipeline.invalidateTurn({ turnId: "turn-b" });
          const drained = expectEvent(
            "PipelineDrained",
            (e) => e.turnId === "turn-b"
          );
          pushChunksSync([sineWavePcm16(SAMPLE_RATE, CHUNK_MS)], "turn-b");
          await drained;
        }),
    },
  ],
};

// ── Suite: microphone capture ───────────────────────────────────────────────

const micCapture: Suite = {
  id: "mic-capture",
  title: "Microphone capture",
  description:
    "Mic events flow with the expected payload shape. Requires mic permission.",
  tests: [
    {
      name: "microphone permission is granted",
      run: async () => {
        const result = await ExpoPlayAudioStream.requestPermissionsAsync();
        assert(result.granted, "microphone permission not granted");
      },
    },
    {
      name: "audio events flow with expected shape",
      run: async () => {
        const events: AudioDataEvent[] = [];
        const { subscription } = await ExpoPlayAudioStream.startMicrophone({
          sampleRate: 16000,
          channels: 1,
          encoding: "pcm_16bit",
          interval: 100,
          onAudioStream: async (e) => {
            events.push(e);
          },
        });
        try {
          await waitFor(() => events.length >= 5, 10000, "5 mic events");
          for (const e of events.slice(0, 5)) {
            assert(typeof e.data === "string", "data must be a base64 string");
            assert((e.data as string).length > 0, "data must be non-empty");
            assert(e.eventDataSize > 0, "eventDataSize must be > 0");
            assert(typeof e.soundLevel === "number", "soundLevel missing");
          }
          assert(
            events[events.length - 1].totalSize > events[0].totalSize,
            "totalSize must advance"
          );
        } finally {
          await ExpoPlayAudioStream.stopMicrophone().catch(() => {});
          subscription?.remove();
        }
      },
    },
    {
      name: "toggleSilence zero-fills but keeps events flowing",
      run: async () => {
        const events: AudioDataEvent[] = [];
        const { subscription } = await ExpoPlayAudioStream.startMicrophone({
          sampleRate: 16000,
          channels: 1,
          encoding: "pcm_16bit",
          interval: 100,
          onAudioStream: async (e) => {
            events.push(e);
          },
        });
        try {
          await waitFor(() => events.length >= 2, 10000, "mic warmup");
          ExpoPlayAudioStream.toggleSilence(true);
          await sleep(300); // let in-flight non-silent events flush
          const from = events.length;
          await waitFor(
            () => events.length >= from + 3,
            10000,
            "3 silenced events"
          );
          const silenced = events.slice(from, from + 3);
          for (const e of silenced) {
            assertEqual(e.soundLevel, -160, "silenced soundLevel");
          }
          ExpoPlayAudioStream.toggleSilence(false);
        } finally {
          ExpoPlayAudioStream.toggleSilence(false);
          await ExpoPlayAudioStream.stopMicrophone().catch(() => {});
          subscription?.remove();
        }
      },
    },
  ],
};

export const suites: Suite[] = [
  pipelineBase64,
  pipelineBinary,
  pipelineEdge,
  micCapture,
];
