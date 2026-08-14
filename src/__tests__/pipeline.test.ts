/**
 * Tests for the Pipeline TS wrapper: verifies what crosses the bridge for
 * each public call, with the native module mocked.
 */

const mockNativeModule: Record<string, jest.Mock> = {
  pushPipelineAudio: jest.fn(async () => undefined),
  pushPipelineAudioSync: jest.fn(() => true),
  pushPipelineAudioBinary: jest.fn(async () => undefined),
  pushPipelineAudioBinarySync: jest.fn(() => true),
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

describe("binary (Uint8Array) push dispatch", () => {
  const bytes = new Uint8Array([1, 0, 2, 0, 3, 0]);

  it("pushAudio routes Uint8Array to the binary native function with positional args", async () => {
    await Pipeline.pushAudio({ audio: bytes, turnId: "t1" });
    expect(mockNativeModule.pushPipelineAudioBinary).toHaveBeenCalledWith(
      bytes,
      "t1",
      false,
      false
    );
    expect(mockNativeModule.pushPipelineAudio).not.toHaveBeenCalled();
  });

  it("pushAudioSync routes Uint8Array to the binary sync function and returns its result", () => {
    expect(Pipeline.pushAudioSync({ audio: bytes, turnId: "t1" })).toBe(true);
    expect(mockNativeModule.pushPipelineAudioBinarySync).toHaveBeenCalledWith(
      bytes,
      "t1",
      false,
      false
    );
    expect(mockNativeModule.pushPipelineAudioSync).not.toHaveBeenCalled();

    mockNativeModule.pushPipelineAudioBinarySync.mockReturnValueOnce(false);
    expect(Pipeline.pushAudioSync({ audio: bytes, turnId: "t1" })).toBe(false);
  });

  it("preserves chunk flags as positional args", async () => {
    await Pipeline.pushAudio({
      audio: bytes,
      turnId: "t2",
      isFirstChunk: true,
      isLastChunk: true,
    });
    expect(mockNativeModule.pushPipelineAudioBinary).toHaveBeenCalledWith(
      bytes,
      "t2",
      true,
      true
    );
  });

  it("passes the exact Uint8Array instance through (no copy at the JS layer)", () => {
    const view = new Uint8Array(new ArrayBuffer(16), 4, 6); // subarray view
    Pipeline.pushAudioSync({ audio: view, turnId: "t1" });
    const passed = mockNativeModule.pushPipelineAudioBinarySync.mock.calls[0][0];
    expect(passed).toBe(view);
    expect(passed.byteOffset).toBe(4);
    expect(passed.byteLength).toBe(6);
  });

  it("string audio still uses the legacy base64 functions", async () => {
    await Pipeline.pushAudio({ audio: "QUJD", turnId: "t1" });
    Pipeline.pushAudioSync({ audio: "QUJD", turnId: "t1" });
    expect(mockNativeModule.pushPipelineAudioBinary).not.toHaveBeenCalled();
    expect(mockNativeModule.pushPipelineAudioBinarySync).not.toHaveBeenCalled();
    expect(mockNativeModule.pushPipelineAudio).toHaveBeenCalledTimes(1);
    expect(mockNativeModule.pushPipelineAudioSync).toHaveBeenCalledTimes(1);
  });

  it("propagates rejection from the binary native function", async () => {
    mockNativeModule.pushPipelineAudioBinary.mockRejectedValueOnce(
      new Error("PIPELINE_PUSH_ERROR")
    );
    await expect(
      Pipeline.pushAudio({ audio: bytes, turnId: "t1" })
    ).rejects.toThrow("PIPELINE_PUSH_ERROR");
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
