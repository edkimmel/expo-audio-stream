/**
 * Tests for the microphone TS wrapper: config forwarding and the mapping
 * from the native AudioData wire payload to the public AudioDataEvent.
 */

const mockNativeModule: Record<string, jest.Mock> = {
  startMicrophone: jest.fn(async () => ({
    fileUri: "",
    channels: 1,
    bitDepth: 16,
    sampleRate: 16000,
    mimeType: "",
  })),
  stopMicrophone: jest.fn(async () => null),
};

const mockListeners: Record<string, Array<(event: unknown) => unknown>> = {};

jest.mock("expo-modules-core", () => ({
  requireNativeModule: jest.fn(() => mockNativeModule),
  EventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn((name: string, cb: (event: unknown) => unknown) => {
      (mockListeners[name] ??= []).push(cb);
      return { remove: jest.fn() };
    }),
  })),
}));

import { ExpoPlayAudioStream } from "../index";
import type { AudioDataEvent } from "../types";

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockListeners)) delete mockListeners[key];
});

describe("startMicrophone", () => {
  it("strips callbacks from the options passed to native", async () => {
    await ExpoPlayAudioStream.startMicrophone({
      sampleRate: 16000,
      channels: 1,
      encoding: "pcm_16bit",
      interval: 100,
      onAudioStream: async () => {},
      onError: () => {},
    });
    expect(mockNativeModule.startMicrophone).toHaveBeenCalledWith({
      sampleRate: 16000,
      channels: 1,
      encoding: "pcm_16bit",
      interval: 100,
    });
    const passed = mockNativeModule.startMicrophone.mock.calls[0][0];
    expect(passed).not.toHaveProperty("onAudioStream");
    expect(passed).not.toHaveProperty("onError");
  });

  it("maps the native AudioData payload onto AudioDataEvent", async () => {
    const received: AudioDataEvent[] = [];
    await ExpoPlayAudioStream.startMicrophone({
      sampleRate: 16000,
      onAudioStream: async (e) => {
        received.push(e);
      },
    });

    await mockListeners["AudioData"][0]({
      encoded: "QUJD",
      fileUri: "",
      lastEmittedSize: 0,
      position: 40,
      deltaSize: 3,
      totalSize: 3,
      mimeType: "audio/wav",
      streamUuid: "u1",
      soundLevel: -20,
      frequencyBands: { low: 0.1, mid: 0.2, high: 0.3 },
    });

    expect(received).toEqual([
      {
        data: "QUJD",
        position: 40,
        fileUri: "",
        eventDataSize: 3,
        totalSize: 3,
        soundLevel: -20,
        frequencyBands: { low: 0.1, mid: 0.2, high: 0.3 },
      },
    ]);
  });

  it("suppresses AudioData error events when onError is wired", async () => {
    const onAudioStream = jest.fn();
    const onError = jest.fn();
    await ExpoPlayAudioStream.startMicrophone({
      sampleRate: 16000,
      onAudioStream,
      onError,
    });

    await mockListeners["AudioData"][0]({
      error: "RECORDING_INTERRUPTED",
      errorMessage: "interrupted",
      fileUri: "",
      lastEmittedSize: 0,
      position: 0,
      deltaSize: 0,
      totalSize: 0,
      mimeType: "",
      streamUuid: "u1",
    });
    expect(onAudioStream).not.toHaveBeenCalled();

    await mockListeners["MicrophoneError"][0]({
      code: "RECORDING_INTERRUPTED",
      message: "interrupted",
      isFatal: true,
      autoResuming: false,
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "RECORDING_INTERRUPTED", isFatal: true })
    );
  });

  it("returns a composite subscription that removes all listeners", async () => {
    const { subscription } = await ExpoPlayAudioStream.startMicrophone({
      sampleRate: 16000,
      onAudioStream: async () => {},
      onError: () => {},
    });
    expect(subscription).toBeDefined();
    expect(() => subscription!.remove()).not.toThrow();
  });
});
