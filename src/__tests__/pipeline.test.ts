/**
 * Tests for the Pipeline TS wrapper: verifies what crosses the bridge for
 * each public call, with the native module mocked.
 */

const mockNativeModule: Record<string, jest.Mock> = {
  pushPipelineAudio: jest.fn(async () => undefined),
  pushPipelineAudioSync: jest.fn(() => true),
  connectPipeline: jest.fn(async () => ({})),
  disconnectPipeline: jest.fn(async () => undefined),
  invalidatePipelineTurn: jest.fn(async () => undefined),
  getPipelineState: jest.fn(() => "idle"),
  getPipelineTelemetry: jest.fn(() => ({})),
  getPipelineOutputLatencyMs: jest.fn(() => 0),
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

import { Pipeline } from "../pipeline";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Pipeline.pushAudio", () => {
  it("forwards the options object to the native async function", async () => {
    await Pipeline.pushAudio({ audio: "QUJD", turnId: "t1" });
    expect(mockNativeModule.pushPipelineAudio).toHaveBeenCalledWith({
      audio: "QUJD",
      turnId: "t1",
    });
  });

  it("preserves chunk flags", async () => {
    await Pipeline.pushAudio({
      audio: "QUJD",
      turnId: "t1",
      isFirstChunk: true,
      isLastChunk: true,
    });
    expect(mockNativeModule.pushPipelineAudio).toHaveBeenCalledWith(
      expect.objectContaining({ isFirstChunk: true, isLastChunk: true })
    );
  });

  it("propagates native rejection", async () => {
    mockNativeModule.pushPipelineAudio.mockRejectedValueOnce(
      new Error("PIPELINE_PUSH_ERROR")
    );
    await expect(
      Pipeline.pushAudio({ audio: "QUJD", turnId: "t1" })
    ).rejects.toThrow("PIPELINE_PUSH_ERROR");
  });
});

describe("Pipeline.pushAudioSync", () => {
  it("forwards the options object and returns the native result", () => {
    expect(Pipeline.pushAudioSync({ audio: "QUJD", turnId: "t1" })).toBe(true);
    expect(mockNativeModule.pushPipelineAudioSync).toHaveBeenCalledWith({
      audio: "QUJD",
      turnId: "t1",
    });

    mockNativeModule.pushPipelineAudioSync.mockReturnValueOnce(false);
    expect(Pipeline.pushAudioSync({ audio: "QUJD", turnId: "t1" })).toBe(false);
  });
});

describe("Pipeline state and telemetry", () => {
  it("passes through getState and getTelemetry", () => {
    mockNativeModule.getPipelineState.mockReturnValueOnce("streaming");
    expect(Pipeline.getState()).toBe("streaming");

    const telemetry = { totalPushCalls: 7 };
    mockNativeModule.getPipelineTelemetry.mockReturnValueOnce(telemetry);
    expect(Pipeline.getTelemetry()).toBe(telemetry);
  });
});

describe("Pipeline.subscribe", () => {
  it("registers a listener under the given event name", () => {
    const listener = jest.fn();
    Pipeline.subscribe("PipelineStateChanged", listener);
    expect(mockListeners["PipelineStateChanged"]).toHaveLength(1);
  });

  it("onError normalizes zombie events into { code, message }", async () => {
    const errors: Array<{ code: string; message: string }> = [];
    Pipeline.onError((e) => errors.push(e));

    await mockListeners["PipelineZombieDetected"][0]({
      playbackHead: 42,
      stalledMs: 5000,
    });
    expect(errors).toEqual([
      expect.objectContaining({ code: "ZOMBIE_DETECTED" }),
    ]);
  });
});
