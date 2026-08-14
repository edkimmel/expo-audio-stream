/**
 * Minimal in-app test runner for the e2e self-test suites.
 *
 * Each suite is a list of named async tests that throw on failure. The
 * SuiteScreen renders results with stable testIDs so Maestro can drive the
 * suites and assert the outcome.
 */

export interface TestCase {
  name: string;
  run: () => Promise<void>;
}

export interface Suite {
  id: string;
  title: string;
  description: string;
  tests: TestCase[];
}

export interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${String(actual)}, want ${String(expected)}`);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `predicate` until true or `timeoutMs` elapses. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout after ${timeoutMs}ms waiting for ${label}`);
    }
    await sleep(50);
  }
}

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64-encode raw bytes (btoa is not guaranteed on all RN runtimes). */
export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : "=";
  }
  return out;
}

/** Generate `ms` milliseconds of mono PCM16 LE sine at `freqHz`. */
export function sineWavePcm16(
  sampleRate: number,
  ms: number,
  freqHz = 440,
  amplitude = 0.3
): Uint8Array {
  const sampleCount = Math.floor((sampleRate * ms) / 1000);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = Math.round(
      Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amplitude * 32767
    );
  }
  // Int16Array is little-endian on every platform React Native targets.
  return new Uint8Array(samples.buffer);
}

/** Run all tests in a suite sequentially, reporting progress per test. */
export async function runSuite(
  suite: Suite,
  onProgress: (results: TestResult[]) => void
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const test of suite.tests) {
    try {
      await test.run();
      results.push({ name: test.name, passed: true });
    } catch (err) {
      results.push({
        name: test.name,
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    onProgress([...results]);
  }
  return results;
}
