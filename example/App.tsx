import { Button, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  ExpoPlayAudioStream,
  Pipeline,
} from "@edkimmel/expo-audio-stream";
import { useEffect, useRef, useState } from "react";
import { sampleA } from "./samples/sample-a";
import { sampleB } from "./samples/sample-b";
import type {
  AudioDataEvent,
} from "@edkimmel/expo-audio-stream";
import type { EventSubscription } from "expo-modules-core";

const ANDROID_SAMPLE_RATE = 24000;
const IOS_SAMPLE_RATE = 24000;
const CHANNELS = 1;
const ENCODING = "pcm_16bit";
const RECORDING_INTERVAL = 30;

// Sample audio files are encoded at 16kHz
const SAMPLE_PLAYBACK_RATE = 16000;

const turnId1 = "turnId1";
const turnId2 = "turnId2";

export default function App() {
  const [pipelineState, setPipelineState] = useState<string>("idle");
  const [isRecording, setIsRecording] = useState(false);

  const eventListenerSubscriptionRef = useRef<EventSubscription | undefined>(
    undefined
  );

  const pipelineSubsRef = useRef<{ remove: () => void }[]>([]);

  const onAudioCallback = async (audio: AudioDataEvent) => {
    const nowMilliseconds = Date.now() % 1000;
    console.log(`Mic data ${nowMilliseconds}:`, audio.data.slice(0, 100));
  };

  // Subscribe to sound chunk played events
  useEffect(() => {
    const sub = ExpoPlayAudioStream.subscribeToSoundChunkPlayed(
      async (event) => {
        console.log("Sound chunk played:", event);
      }
    );

    return () => {
      sub.remove();
      ExpoPlayAudioStream.destroy();
    };
  }, []);

  const connectPipeline = async () => {
    try {
      const result = await Pipeline.connect({
        sampleRate: SAMPLE_PLAYBACK_RATE,
        channelCount: 1,
        targetBufferMs: 80,
      });
      console.log("Pipeline connected:", result);

      // Subscribe to all pipeline events
      const stateSub = Pipeline.subscribe(
        "PipelineStateChanged",
        async (e) => {
          console.log("Pipeline state:", e.state);
          setPipelineState(e.state);
        }
      );

      const playbackStartedSub = Pipeline.subscribe(
        "PipelinePlaybackStarted",
        async (e) => {
          console.log("Pipeline playback started, turnId:", e.turnId);
        }
      );

      const drainSub = Pipeline.subscribe("PipelineDrained", async (e) => {
        console.log("Pipeline drained, turnId:", e.turnId);
      });

      const underrunSub = Pipeline.subscribe(
        "PipelineUnderrun",
        async (e) => {
          console.log("Pipeline underrun, count:", e.count);
        }
      );

      const errorSub = Pipeline.onError((err) => {
        console.error(`Pipeline error: ${err.code} - ${err.message}`);
      });

      const focusSub = Pipeline.onAudioFocus((e) => {
        console.log("Pipeline audio focus:", e.focused ? "resumed" : "lost");
      });

      pipelineSubsRef.current = [
        stateSub,
        playbackStartedSub,
        drainSub,
        underrunSub,
        errorSub,
        focusSub,
      ];
    } catch (err) {
      console.error("Pipeline connect failed:", err);
    }
  };

  const disconnectPipeline = async () => {
    try {
      await Pipeline.disconnect();
      pipelineSubsRef.current.forEach((s) => s.remove());
      pipelineSubsRef.current = [];
      setPipelineState("idle");
    } catch (err) {
      console.error("Pipeline disconnect failed:", err);
    }
  };

  const pushSampleToPipeline = () => {
    const success = Pipeline.pushAudioSync({
      audio: sampleA,
      turnId: "pipeline-turn-1",
      isFirstChunk: true,
      isLastChunk: true,
    });
    console.log("Pipeline push:", success ? "ok" : "failed");
  };

  const pushSample10x = () => {
    const turnId = "pipeline-turn-10x";
    for (let i = 0; i < 10; i++) {
      const success = Pipeline.pushAudioSync({
        audio: sampleA,
        turnId,
        isFirstChunk: i === 0,
        isLastChunk: i === 9,
      });
      console.log(`Pipeline push ${i + 1}/10:`, success ? "ok" : "failed");
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.header}>expo-audio-stream</Text>

      {/* ── Sound Playback ──────────────────────────────── */}
      <Text style={styles.section}>Sound Playback</Text>

      <Button
        onPress={async () => {
          await ExpoPlayAudioStream.setSoundConfig({
            sampleRate: SAMPLE_PLAYBACK_RATE,
            playbackMode: "regular",
          });
          await ExpoPlayAudioStream.playSound(sampleB, turnId1);
        }}
        title="Play Sample B (turn 1)"
      />
      <Spacer />

      <Button
        onPress={async () => {
          await ExpoPlayAudioStream.setSoundConfig({
            sampleRate: SAMPLE_PLAYBACK_RATE,
            playbackMode: "regular",
          });
          await ExpoPlayAudioStream.playSound(sampleA, turnId2);
        }}
        title="Play Sample A (turn 2)"
      />
      <Spacer />

      <Button
        onPress={async () => {
          await ExpoPlayAudioStream.stopSound();
        }}
        title="Stop Sound"
      />
      <Spacer />

      <Button
        onPress={async () => {
          await ExpoPlayAudioStream.clearSoundQueueByTurnId(turnId1);
        }}
        title="Clear Turn 1 Queue"
      />

      {/* ── Microphone ─────────────────────────────────── */}
      <Text style={styles.section}>Microphone</Text>

      <Button
        onPress={async () => {
          if (!(await isMicrophonePermissionGranted())) {
            const granted = await requestMicrophonePermission();
            if (!granted) return;
          }
          const sampleRate =
            Platform.OS === "ios" ? IOS_SAMPLE_RATE : ANDROID_SAMPLE_RATE;
          const { recordingResult, subscription } =
            await ExpoPlayAudioStream.startMicrophone({
              interval: RECORDING_INTERVAL,
              sampleRate,
              channels: CHANNELS,
              encoding: ENCODING,
              onAudioStream: onAudioCallback,
            });
          console.log("Recording started:", JSON.stringify(recordingResult));
          eventListenerSubscriptionRef.current = subscription;
          setIsRecording(true);
        }}
        title="Start Microphone"
      />
      <Spacer />

      <Button
        onPress={async () => {
          await ExpoPlayAudioStream.stopMicrophone();
          eventListenerSubscriptionRef.current?.remove();
          eventListenerSubscriptionRef.current = undefined;
          setIsRecording(false);
        }}
        title="Stop Microphone"
      />

      <Text style={styles.status}>
        Mic: {isRecording ? "recording" : "idle"}
      </Text>

      {/* ── Pipeline ───────────────────────────────────── */}
      <Text style={styles.section}>Pipeline</Text>

      <Button onPress={connectPipeline} title="Connect Pipeline" />
      <Spacer />

      <Button onPress={pushSampleToPipeline} title="Push Sample to Pipeline" />
      <Spacer />

      <Button onPress={pushSample10x} title="Push Sample 10x (buffer test)" />
      <Spacer />

      <Button
        onPress={() => {
          Pipeline.invalidateTurn({ turnId: "pipeline-turn-2" });
          console.log("Turn invalidated");
        }}
        title="Invalidate Turn"
      />
      <Spacer />

      <Button
        onPress={() => {
          const telemetry = Pipeline.getTelemetry();
          console.log("Telemetry:", JSON.stringify(telemetry, null, 2));
        }}
        title="Log Telemetry"
      />
      <Spacer />

      <Button onPress={disconnectPipeline} title="Disconnect Pipeline" />

      <Text style={styles.status}>Pipeline: {pipelineState}</Text>
    </ScrollView>
  );
}

function Spacer() {
  return <View style={{ height: 8 }} />;
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  header: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 20,
  },
  section: {
    fontSize: 16,
    fontWeight: "600",
    marginTop: 24,
    marginBottom: 10,
    alignSelf: "flex-start",
    color: "#333",
  },
  status: {
    marginTop: 8,
    fontSize: 13,
    color: "#666",
  },
});

const requestMicrophonePermission = async (): Promise<boolean> => {
  const result = await ExpoPlayAudioStream.requestPermissionsAsync();
  return result.granted;
};

const isMicrophonePermissionGranted = async (): Promise<boolean> => {
  const result = await ExpoPlayAudioStream.getPermissionsAsync();
  return result.granted;
};
