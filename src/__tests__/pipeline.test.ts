// expo-modules-core ships ESM source that Jest doesn't transform; events.ts
// constructs a real EventEmitter at import time, so stub it.
jest.mock('expo-modules-core', () => ({
  EventEmitter: class {
    addListener() {
      return { remove() {} }
    }
  },
  requireNativeModule: () => ({}),
}))

// Mock the native module wrapper so no real native binding is required.
// `../ExpoPlayAudioStreamModule` resolves to the same module that
// `src/pipeline/index.ts` imports, so the mock is shared.
jest.mock('../ExpoPlayAudioStreamModule', () => ({
  __esModule: true,
  default: {
    connectPipeline: jest.fn().mockResolvedValue({ ok: true }),
  },
}))

import ExpoPlayAudioStreamModule from '../ExpoPlayAudioStreamModule'
import { Pipeline } from '../pipeline'

describe('Pipeline.connect', () => {
  it('forwards options to the native connectPipeline', async () => {
    const options = { sampleRate: 24000 }
    await Pipeline.connect(options)
    expect(
      (ExpoPlayAudioStreamModule as unknown as { connectPipeline: jest.Mock })
        .connectPipeline
    ).toHaveBeenCalledWith(options)
  })
})
