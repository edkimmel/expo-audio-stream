import Foundation

/// Lightweight IIR-based frequency band analyzer.
///
/// Uses two parallel single-pole low-pass filters to split audio into
/// low / mid / high bands and accumulate RMS energy.
/// Thread-safe: `processSamples` and `harvest` may be called from
/// different threads (guarded by an internal lock).
struct FrequencyBands {
    let low: Float
    let mid: Float
    let high: Float

    static let zero = FrequencyBands(low: 0, mid: 0, high: 0)
}

class FrequencyBandAnalyzer {
    // ── Coefficients (immutable after init) ──────────────────────────
    private let alphaLow: Float
    private let alphaHigh: Float

    // ── Filter state ─────────────────────────────────────────────────
    private var lp1: Float = 0       // low-pass accumulator (low crossover)
    private var lp2: Float = 0       // low-pass accumulator (high crossover)

    // ── Energy accumulators ──────────────────────────────────────────
    private var lowE: Float = 0
    private var midE: Float = 0
    private var highE: Float = 0
    private var count: Int = 0

    // ── Synchronization ──────────────────────────────────────────────
    private let lock = NSLock()

    init(sampleRate: Int, lowCrossoverHz: Float = 300, highCrossoverHz: Float = 2000) {
        let sr = Float(sampleRate)
        self.alphaLow = min(1, (2 * Float.pi * lowCrossoverHz) / sr)
        self.alphaHigh = min(1, (2 * Float.pi * highCrossoverHz) / sr)
    }

    /// Process a batch of PCM16 samples. Accumulates energy — does NOT
    /// produce output. Call `harvest()` to read and reset.
    func processSamples(_ samples: UnsafePointer<Int16>, count sampleCount: Int) {
        lock.lock()
        defer { lock.unlock() }

        for i in 0..<sampleCount {
            let s = Float(samples[i]) / 32768.0

            lp1 += alphaLow * (s - lp1)
            lp2 += alphaHigh * (s - lp2)

            let low = lp1
            let high = s - lp2
            let mid = s - low - high

            lowE += low * low
            midE += mid * mid
            highE += high * high
            count += 1
        }
    }

    /// Process PCM16 samples from a Data blob (little-endian Int16).
    func processSamplesFromData(_ data: Data) {
        data.withUnsafeBytes { rawBuffer in
            guard let ptr = rawBuffer.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            let sampleCount = data.count / 2
            processSamples(ptr, count: sampleCount)
        }
    }

    /// Whether any samples have been accumulated since the last harvest/reset.
    func hasData() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return count > 0
    }

    /// Read accumulated band energy scaled to 0–1 using dB mapping,
    /// then reset accumulators.
    ///
    /// Raw RMS of speech/music PCM typically sits around 0.01–0.15,
    /// which is unusable for a visual meter. Converting to dB and
    /// mapping the range [–60 dB, 0 dB] → [0, 1] gives perceptually
    /// meaningful values.
    func harvest() -> FrequencyBands {
        lock.lock()
        defer { lock.unlock() }

        guard count > 0 else { return .zero }

        let n = Float(count)
        let result = FrequencyBands(
            low: Self.rmsToScaled(sqrt(lowE / n)),
            mid: Self.rmsToScaled(sqrt(midE / n)),
            high: Self.rmsToScaled(sqrt(highE / n))
        )

        lowE = 0
        midE = 0
        highE = 0
        count = 0

        return result
    }

    // ── dB scaling ────────────────────────────────────────────────────

    /// Floor in dB — anything below this maps to 0.
    private static let dbFloor: Float = -60

    /// Convert raw RMS (0…1) to a 0–1 meter value via dB scaling.
    ///   rms 0.09  → –20.9 dB → 0.65
    ///   rms 0.01  → –40   dB → 0.33
    ///   rms 0.001 → –60   dB → 0.0
    private static func rmsToScaled(_ rms: Float) -> Float {
        guard rms > 0 else { return 0 }
        let db = 20 * log10(rms)
        return max(0, min(1, (db - dbFloor) / -dbFloor))
    }

    /// Zero all state (filter accumulators + energy).
    func reset() {
        lock.lock()
        defer { lock.unlock() }

        lp1 = 0
        lp2 = 0
        lowE = 0
        midE = 0
        highE = 0
        count = 0
    }
}
