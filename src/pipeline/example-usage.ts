// ────────────────────────────────────────────────────────────────────────────
// Native Audio Pipeline — V3 Example Usage
// ────────────────────────────────────────────────────────────────────────────
//
// Shows how to wire a WebSocket (e.g., xAI realtime API) to the native
// pipeline using pushAudioSync on the hot path, with turn management,
// zombie recovery, and audio focus handling.
//
// This file is an EXAMPLE — not imported by the library itself.

import { Pipeline } from './index';
import type { EventSubscription } from 'expo-modules-core';

// ── Types for the example ───────────────────────────────────────────────────

interface RealtimeAudioMessage {
  type: 'audio';
  turnId: string;
  audio: string; // base64 PCM16 LE
  isFirst?: boolean;
  isLast?: boolean;
}

interface RealtimeTurnMessage {
  type: 'turn_start' | 'turn_end';
  turnId: string;
}

type RealtimeMessage = RealtimeAudioMessage | RealtimeTurnMessage;

// ── Example implementation ──────────────────────────────────────────────────

export async function startRealtimeSession(wsUrl: string) {
  // 1. Connect the native pipeline
  const config = await Pipeline.connect({
    sampleRate: 24000,
    channelCount: 1,
    targetBufferMs: 80,
  });
  console.log(
    `Pipeline connected: ${config.sampleRate}Hz, frame=${config.frameSizeSamples} samples`
  );

  // 2. Set up event listeners
  const subs: { remove: () => void }[] = [];

  subs.push(
    Pipeline.subscribe('PipelineStateChanged', async (e) => {
      console.log(`Pipeline state: ${e.state}`);
    })
  );

  subs.push(
    Pipeline.subscribe('PipelinePlaybackStarted', async (e) => {
      console.log(`Playback started for turn: ${e.turnId}`);
    })
  );

  subs.push(
    Pipeline.subscribe('PipelineDrained', async (e) => {
      console.log(`Turn drained: ${e.turnId}`);
    })
  );

  subs.push(
    Pipeline.subscribe('PipelineUnderrun', async (e) => {
      console.log(`Underrun #${e.count}`);
    })
  );

  // Error handler — covers both PipelineError and zombie detection
  subs.push(
    Pipeline.onError((err) => {
      console.error(`Pipeline error [${err.code}]: ${err.message}`);

      if (err.code === 'ZOMBIE_DETECTED') {
        // Recovery strategy: disconnect, reconnect, and ask the AI to
        // resend the current turn
        handleZombieRecovery(wsUrl);
      }
    })
  );

  // Audio focus handler — during focus loss the pipeline writes silence.
  // On regain, invalidate the turn and re-request from the AI.
  let currentTurnId: string | null = null;

  subs.push(
    Pipeline.onAudioFocus(({ focused }) => {
      if (focused) {
        console.log('Audio focus regained — re-requesting turn');
        if (currentTurnId) {
          // Invalidate stale audio and request fresh data
          Pipeline.invalidateTurn({ turnId: `${currentTurnId}-refocus` });
          // In a real app, you'd send a message to the AI to re-generate
          // the current turn from the last known position.
        }
      } else {
        console.log(
          'Audio focus lost — pipeline writing silence, data lost during this period'
        );
      }
    })
  );

  // 3. Open WebSocket to the realtime API
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (event) => {
    const msg: RealtimeMessage = JSON.parse(event.data);

    switch (msg.type) {
      case 'audio': {
        currentTurnId = msg.turnId;

        // HOT PATH — synchronous push, no async overhead
        const ok = Pipeline.pushAudioSync({
          audio: msg.audio,
          turnId: msg.turnId,
          isFirstChunk: msg.isFirst,
          isLastChunk: msg.isLast,
        });

        if (!ok) {
          console.warn('pushAudioSync returned false — pipeline may be disconnected');
        }
        break;
      }

      case 'turn_start': {
        currentTurnId = msg.turnId;
        // No explicit action needed — isFirstChunk on the first audio
        // message handles jitter buffer reset.
        break;
      }

      case 'turn_end': {
        // If the server signals turn end without a final audio chunk,
        // we can invalidate or just let the buffer drain naturally.
        break;
      }
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };

  ws.onclose = () => {
    console.log('WebSocket closed — disconnecting pipeline');
    cleanup();
  };

  // 4. Return cleanup function
  function cleanup() {
    subs.forEach((s) => s.remove());
    Pipeline.disconnect().catch(console.error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }

  return { cleanup, ws };
}

// ── Zombie recovery ─────────────────────────────────────────────────────────

async function handleZombieRecovery(wsUrl: string) {
  console.log('Attempting zombie recovery...');

  try {
    // Tear down the zombie pipeline
    await Pipeline.disconnect();

    // Small delay to let the system settle
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Reconnect
    await Pipeline.connect({
      sampleRate: 24000,
      channelCount: 1,
      targetBufferMs: 80,
    });

    console.log('Zombie recovery complete — pipeline reconnected');
    // In a real app, you'd signal the AI to re-send audio from the
    // current position or restart the turn.
  } catch (err) {
    console.error('Zombie recovery failed:', err);
  }
}

// ── Telemetry polling example ───────────────────────────────────────────────

export function startTelemetryPolling(intervalMs: number = 2000) {
  const timer = setInterval(() => {
    const telemetry = Pipeline.getTelemetry();
    console.log(
      `[Telemetry] state=${telemetry.state} ` +
      `buf=${telemetry.bufferMs}ms ` +
      `primed=${telemetry.primed} ` +
      `underruns=${telemetry.underrunCount} ` +
      `pushes=${telemetry.totalPushCalls} ` +
      `loops=${telemetry.totalWriteLoops}`
    );
  }, intervalMs);

  return { stop: () => clearInterval(timer) };
}
