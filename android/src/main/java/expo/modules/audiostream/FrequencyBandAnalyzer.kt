package expo.modules.audiostream

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.PI
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * RMS energy per frequency band, range [0, 1].
 */
data class FrequencyBands(
    val low: Float,
    val mid: Float,
    val high: Float
) {
    companion object {
        val ZERO = FrequencyBands(0f, 0f, 0f)
    }
}

/**
 * Lightweight IIR-based frequency band analyzer.
 *
 * Uses two parallel single-pole low-pass filters to split audio into
 * low / mid / high bands and accumulate RMS energy.
 * Thread-safe: [processSamples] and [harvest] may be called from
 * different threads (guarded by an internal lock).
 */
class FrequencyBandAnalyzer(
    sampleRate: Int,
    lowCrossoverHz: Float = 300f,
    highCrossoverHz: Float = 2000f
) {
    // ── Coefficients (immutable after init) ──────────────────────────
    private val alphaLow: Float = min(1f, (2f * PI.toFloat() * lowCrossoverHz) / sampleRate)
    private val alphaHigh: Float = min(1f, (2f * PI.toFloat() * highCrossoverHz) / sampleRate)

    // ── Filter state ─────────────────────────────────────────────────
    private var lp1: Float = 0f
    private var lp2: Float = 0f

    // ── Energy accumulators ──────────────────────────────────────────
    private var lowE: Float = 0f
    private var midE: Float = 0f
    private var highE: Float = 0f
    private var count: Int = 0

    // ── Synchronization ──────────────────────────────────────────────
    private val lock = ReentrantLock()

    /**
     * Process a batch of PCM16 samples. Accumulates energy — does NOT
     * produce output. Call [harvest] to read and reset.
     */
    fun processSamples(samples: ShortArray, length: Int = samples.size) {
        lock.withLock {
            for (i in 0 until length) {
                val s = samples[i].toFloat() / 32768f

                lp1 += alphaLow * (s - lp1)
                lp2 += alphaHigh * (s - lp2)

                val low = lp1
                val high = s - lp2
                val mid = s - low - high

                lowE += low * low
                midE += mid * mid
                highE += high * high
                count++
            }
        }
    }

    /**
     * Process PCM16 samples from a ByteArray (little-endian Int16).
     */
    fun processSamplesFromBytes(data: ByteArray, length: Int = data.size) {
        val sampleCount = length / 2
        val samples = ShortArray(sampleCount)
        val buf = java.nio.ByteBuffer.wrap(data, 0, length)
            .order(java.nio.ByteOrder.LITTLE_ENDIAN)
            .asShortBuffer()
        buf.get(samples)
        processSamples(samples, sampleCount)
    }

    /** Whether any samples have been accumulated since the last harvest/reset. */
    fun hasData(): Boolean = lock.withLock { count > 0 }

    /**
     * Read accumulated band energy scaled to 0–1 using dB mapping,
     * then reset accumulators.
     *
     * Raw RMS of speech/music PCM typically sits around 0.01–0.15,
     * which is unusable for a visual meter. Converting to dB and
     * mapping the range [–60 dB, 0 dB] → [0, 1] gives perceptually
     * meaningful values.
     */
    fun harvest(): FrequencyBands {
        lock.withLock {
            if (count == 0) return FrequencyBands.ZERO

            val n = count.toFloat()
            val result = FrequencyBands(
                low = rmsToScaled(sqrt(lowE / n)),
                mid = rmsToScaled(sqrt(midE / n)),
                high = rmsToScaled(sqrt(highE / n))
            )

            lowE = 0f
            midE = 0f
            highE = 0f
            count = 0

            return result
        }
    }

    companion object {
        /** Floor in dB — anything below this maps to 0. */
        private const val DB_FLOOR = -60f

        /**
         * Convert raw RMS (0…1) to a 0–1 meter value via dB scaling.
         *   rms 0.09  → –20.9 dB → 0.65
         *   rms 0.01  → –40   dB → 0.33
         *   rms 0.001 → –60   dB → 0.0
         */
        private fun rmsToScaled(rms: Float): Float {
            if (rms <= 0f) return 0f
            val db = 20f * log10(rms)
            return max(0f, min(1f, (db - DB_FLOOR) / -DB_FLOOR))
        }
    }

    /**
     * Zero all state (filter accumulators + energy).
     */
    fun reset() {
        lock.withLock {
            lp1 = 0f
            lp2 = 0f
            lowE = 0f
            midE = 0f
            highE = 0f
            count = 0
        }
    }
}
