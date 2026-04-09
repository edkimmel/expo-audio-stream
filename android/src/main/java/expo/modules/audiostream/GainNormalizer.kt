package expo.modules.audiostream

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Adaptive gain normalizer for PCM-16 audio.
 *
 * Measures per-chunk RMS and adjusts a smoothed gain multiplier to push
 * speech toward [targetLevelDbfs].  Attack is fast (captures the start of
 * an utterance quickly), release is slow (holds gain through pauses and
 * plosives so it doesn't clip the next syllable).
 *
 * Yes, this is effectively AGC — the CDD says VOICE_RECOGNITION shouldn't
 * have it, but the raw levels on many devices are too low for third-party
 * server-side VAD that we don't control.  Pragmatism wins.
 */
class GainNormalizer(
    /** Target RMS level in dBFS.  -16 is loud enough for most VAD services. */
    private val targetLevelDbfs: Float = -16f,

    /** RMS below this is silence — don't adapt gain during silence. */
    private val silenceThresholdDbfs: Float = -50f,

    /** Attack coefficient (0–1).  Lower = faster.  0.2 ≈ ramps up in 2–3 chunks. */
    private val attackCoeff: Float = 0.2f,

    /** Release coefficient (0–1).  Higher = slower.  0.95 ≈ holds through ~500ms pause at 100ms chunks. */
    private val releaseCoeff: Float = 0.95f,

    /** Hard ceiling on gain to prevent blowing up near-silence into noise. */
    private val maxGain: Float = 10.0f,

    /** Minimum gain — never attenuate below unity. */
    private val minGain: Float = 1.0f
) {
    private var currentGain: Float = 1.0f

    /**
     * Process a PCM-16 LE chunk in place.
     *
     * @param data   PCM-16 little-endian byte array
     * @param length valid bytes (must be even)
     */
    fun apply(data: ByteArray, length: Int): ByteArray {
        val buf = ByteBuffer.wrap(data, 0, length).order(ByteOrder.LITTLE_ENDIAN)
        val sampleCount = length / 2

        // --- measure RMS ---
        var sumSquares = 0.0
        for (i in 0 until sampleCount) {
            val s = buf.getShort(i * 2).toInt()
            sumSquares += s.toDouble() * s.toDouble()
        }
        val rms = Math.sqrt(sumSquares / sampleCount).toFloat()
        val rmsDbfs = if (rms > 0f) 20f * Math.log10(rms.toDouble() / Short.MAX_VALUE).toFloat() else -100f

        // --- adapt gain (only during speech, not silence) ---
        if (rmsDbfs > silenceThresholdDbfs) {
            val desiredGain = Math.pow(10.0, (targetLevelDbfs - rmsDbfs).toDouble() / 20.0)
                .toFloat()
                .coerceIn(minGain, maxGain)

            // Fast attack, slow release
            val coeff = if (desiredGain < currentGain) attackCoeff else releaseCoeff
            currentGain = coeff * currentGain + (1f - coeff) * desiredGain
        }
        // During silence: hold currentGain — don't adapt, don't reset.

        if (currentGain < 1.01f) return data  // unity, skip work

        // --- apply gain only to non-silent chunks ---
        // If this chunk is silence, don't amplify it — keeps the noise floor
        // untouched so server-side VAD sees a clean gap between speech and quiet.
        if (rmsDbfs <= silenceThresholdDbfs) return data

        for (i in 0 until sampleCount) {
            val offset = i * 2
            val sample = buf.getShort(offset).toInt()
            val amplified = (sample * currentGain).toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            buf.putShort(offset, amplified.toShort())
        }

        return data
    }
}
