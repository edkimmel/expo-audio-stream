// Standalone unit tests for ios/JitterBuffer.swift.
//
// JitterBuffer has no dependencies beyond Foundation, so these run without
// Xcode or a simulator — CI compiles and executes them directly:
//
//   swiftc -parse-as-library ios/JitterBuffer.swift tests/ios/JitterBufferTests.swift -o jbtest && ./jbtest
//
// The file is outside ios/, so the podspec (source_files = "**/*.{h,m,swift}"
// relative to ios/) never ships it.
//
// Convention used throughout: sampleRate=1000 Hz, mono, targetBufferMs=100
// → priming gate opens at 100 samples.

import Foundation

var failures = 0

func expect(_ condition: Bool, _ label: String) {
    if condition {
        print("  ok — \(label)")
    } else {
        failures += 1
        print("  FAIL — \(label)")
    }
}

func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ label: String) {
    expect(actual == expected, "\(label) (got \(actual), want \(expected))")
}

func makeBuffer(targetBufferMs: Int = 100) -> JitterBuffer {
    JitterBuffer(sampleRate: 1000, channels: 1, targetBufferMs: targetBufferMs)
}

func samples(_ range: ClosedRange<Int>) -> [Int16] {
    range.map { Int16($0) }
}

@main
struct JitterBufferTests {
    static func main() {
        print("JitterBuffer tests")

        print("read returns silence until priming threshold is reached:")
        do {
            let buf = makeBuffer()
            buf.write(samples: samples(1...50))
            var dest = [Int16](repeating: 99, count: 10)
            buf.read(dest: &dest)
            expect(!buf.isPrimed(), "gate stays closed below threshold")
            expect(dest.allSatisfy { $0 == 0 }, "silence while unprimed")
            expectEqual(buf.availableSamples(), 50, "silence reads do not consume audio")
        }

        print("priming gate opens once enough audio accumulates:")
        do {
            let buf = makeBuffer()
            buf.write(samples: samples(1...100))
            expect(buf.isPrimed(), "gate opens at threshold")
            var dest = [Int16](repeating: 0, count: 10)
            buf.read(dest: &dest)
            expectEqual(dest, samples(1...10), "first frame after priming")
        }

        print("markEndOfStream force-primes so the tail drains:")
        do {
            let buf = makeBuffer()
            buf.write(samples: samples(1...30))
            buf.markEndOfStream()
            expect(buf.isPrimed(), "EOS force-primes")
            var dest = [Int16](repeating: 0, count: 30)
            buf.read(dest: &dest)
            expectEqual(dest, samples(1...30), "tail drains in order")
            expect(buf.isDrained(), "drained after tail read")
        }

        print("sample order is preserved across chunk boundaries and odd read sizes:")
        do {
            let buf = makeBuffer(targetBufferMs: 0)
            buf.write(samples: samples(1...7))
            buf.write(samples: samples(8...12))
            buf.write(samples: samples(13...20))
            var out: [Int16] = []
            var dest = [Int16](repeating: 0, count: 3)
            for _ in 0..<6 {
                buf.read(dest: &dest)
                out.append(contentsOf: dest)
            }
            expectEqual(Array(out.prefix(18)), samples(1...18), "FIFO order across chunks")
            expect(out.dropFirst(18).allSatisfy { $0 == 0 }, "zero-fill after data runs out")
        }

        print("write with offset copies only the subrange:")
        do {
            let buf = makeBuffer(targetBufferMs: 0)
            buf.write(samples: samples(1...10), offset: 4, length: 3) // samples 5,6,7
            var dest = [Int16](repeating: 0, count: 3)
            buf.read(dest: &dest)
            expectEqual(dest, [5, 6, 7], "subrange write")
        }

        print("underrun is counted when primed and data runs out:")
        do {
            let buf = makeBuffer(targetBufferMs: 0)
            buf.write(samples: samples(1...5))
            var dest = [Int16](repeating: 0, count: 10)
            buf.read(dest: &dest)
            expectEqual(buf.underrunCount, 1, "underrun counted")
            expectEqual(Array(dest.prefix(5)), samples(1...5), "real samples first")
            expect(dest.dropFirst(5).allSatisfy { $0 == 0 }, "remainder zero-filled")
        }

        print("zero-fill after end of stream is not an underrun:")
        do {
            let buf = makeBuffer(targetBufferMs: 0)
            buf.write(samples: samples(1...5))
            buf.markEndOfStream()
            var dest = [Int16](repeating: 0, count: 10)
            buf.read(dest: &dest)
            expectEqual(buf.underrunCount, 0, "drain is not an underrun")
            expect(buf.isDrained(), "drained")
        }

        print("reset discards audio and closes the gate but keeps telemetry:")
        do {
            let buf = makeBuffer()
            buf.write(samples: samples(1...150))
            buf.markEndOfStream()
            buf.reset()
            expectEqual(buf.availableSamples(), 0, "buffer emptied")
            expect(!buf.isPrimed(), "gate closed")
            expect(!buf.isDrained(), "EOS cleared")
            expectEqual(buf.totalWritten, 150, "telemetry survives reset")
            buf.resetTelemetry()
            expectEqual(buf.totalWritten, 0, "resetTelemetry clears counters")
            expectEqual(buf.peakLevel, 0, "peak cleared")
        }

        print("telemetry tracks written, read, and peak levels:")
        do {
            let buf = makeBuffer(targetBufferMs: 0)
            buf.write(samples: samples(1...40))
            buf.write(samples: samples(41...100))
            expectEqual(buf.totalWritten, 100, "totalWritten")
            expectEqual(buf.peakLevel, 100, "peakLevel")
            expectEqual(buf.bufferedMs(), 100, "bufferedMs at 1kHz mono")
            var dest = [Int16](repeating: 0, count: 60)
            buf.read(dest: &dest)
            expectEqual(buf.totalRead, 60, "totalRead")
            expectEqual(buf.availableSamples(), 40, "remaining samples")
        }

        if failures > 0 {
            print("\n\(failures) assertion(s) FAILED")
            exit(1)
        }
        print("\nAll assertions passed")
    }
}
