package expo.modules.audiostream.pipeline

import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Lock-based circular ring buffer for PCM audio (16-bit signed, little-endian).
 *
 * Single producer (bridge thread) writes decoded PCM via [write].
 * Single consumer (write thread) drains via [read].
 * All shared state is guarded by a [ReentrantLock].
 *
 * Features:
 *   - Priming gate: [read] returns silence until [targetBufferMs] of audio has
 *     accumulated (or [markEndOfStream] force-primes so the tail drains).
 *   - Silence-fill on underflow: when the buffer has fewer samples than the
 *     consumer requested, the remainder is filled with silence and an underrun
 *     is counted.
 *   - Telemetry via atomics: total frames written/read, underrun count, peak
 *     buffer level – all readable without acquiring the lock.
 */
class JitterBuffer(
    /** Sample rate in Hz — used to convert between samples and milliseconds. */
    private val sampleRate: Int,
    /** Number of channels (1 = mono, 2 = stereo). */
    private val channels: Int,
    /** How many ms of audio to accumulate before the priming gate opens. */
    private val targetBufferMs: Int,
    /** Ring capacity in *samples* (not bytes). Caller sizes this at connect time. */
    capacitySamples: Int
) {
    // ── Ring storage ────────────────────────────────────────────────────
    private val ring = ShortArray(capacitySamples)
    private var writePos = 0          // next index the producer will fill
    private var readPos = 0           // next index the consumer will drain
    private var count = 0             // number of live samples in the ring

    // ── Priming gate ────────────────────────────────────────────────────
    private val primingSamples: Int =
        (sampleRate * channels * targetBufferMs) / 1000
    private var primed = false

    // ── End-of-stream ───────────────────────────────────────────────────
    private var endOfStream = false

    // ── Lock ────────────────────────────────────────────────────────────
    private val lock = ReentrantLock()

    // ── Telemetry (lock-free reads) ─────────────────────────────────────
    /** Total samples written by the producer since last [reset]. */
    val totalWritten = AtomicLong(0)

    /** Total samples read by the consumer since last [reset]. */
    val totalRead = AtomicLong(0)

    /** Number of underrun events (consumer asked for more than available). */
    val underrunCount = AtomicInteger(0)

    /** Peak buffer level in samples observed at write time. */
    val peakLevel = AtomicInteger(0)

    // ── Producer API ────────────────────────────────────────────────────

    /**
     * Append [samples] into the ring buffer.
     *
     * If there isn't enough room the *oldest* samples are silently dropped
     * (overwrite semantics) — this keeps the buffer fresh rather than
     * blocking the bridge thread.
     *
     * @return number of samples actually written (always `samples.size`).
     */
    fun write(samples: ShortArray, offset: Int = 0, length: Int = samples.size): Int {
        lock.withLock {
            for (i in 0 until length) {
                if (count == ring.size) {
                    // Overwrite oldest – advance readPos
                    readPos = (readPos + 1) % ring.size
                    count--
                }
                ring[writePos] = samples[offset + i]
                writePos = (writePos + 1) % ring.size
                count++
            }

            // Update peak telemetry
            val current = count
            if (current > peakLevel.get()) {
                peakLevel.set(current)
            }

            totalWritten.addAndGet(length.toLong())

            // Check priming
            if (!primed && count >= primingSamples) {
                primed = true
            }

            return length
        }
    }

    // ── Consumer API ────────────────────────────────────────────────────

    /**
     * Fill [dest] with up to [length] samples from the ring buffer.
     *
     * Behaviour depends on the priming gate:
     *   - **Not primed & no end-of-stream**: fills [dest] with silence and
     *     returns [length] (the consumer keeps writing silence to AudioTrack
     *     so it stays alive).
     *   - **Primed (or EOS forced-prime)**: copies available samples; if fewer
     *     than [length] are available the remainder is zero-filled and an
     *     underrun is recorded.
     *
     * @return the number of samples placed in [dest] (always [length]).
     */
    fun read(dest: ShortArray, offset: Int = 0, length: Int = dest.size): Int {
        lock.withLock {
            if (!primed) {
                // Still priming – fill with silence
                for (i in 0 until length) {
                    dest[offset + i] = 0
                }
                return length
            }

            val available = count.coerceAtMost(length)

            // Copy available samples
            for (i in 0 until available) {
                dest[offset + i] = ring[readPos]
                readPos = (readPos + 1) % ring.size
            }
            count -= available

            // Silence-fill remainder on underflow
            if (available < length) {
                for (i in available until length) {
                    dest[offset + i] = 0
                }
                underrunCount.incrementAndGet()
            }

            totalRead.addAndGet(length.toLong())
            return length
        }
    }

    // ── Control API ─────────────────────────────────────────────────────

    /**
     * Mark that the producer will not write any more data for this turn.
     * Force-primes the buffer so the consumer can drain whatever remains
     * rather than waiting for [targetBufferMs] to fill.
     */
    fun markEndOfStream() {
        lock.withLock {
            endOfStream = true
            if (!primed) {
                primed = true  // force open the gate so tail audio drains
            }
        }
    }

    /** @return `true` after [markEndOfStream] was called AND the buffer is empty. */
    fun isDrained(): Boolean {
        lock.withLock {
            return endOfStream && count == 0
        }
    }

    /** Current buffer level in samples (snapshot). */
    fun availableSamples(): Int {
        lock.withLock {
            return count
        }
    }

    /** Current buffer level converted to milliseconds. */
    fun bufferedMs(): Int {
        lock.withLock {
            return if (sampleRate * channels == 0) 0
            else (count * 1000) / (sampleRate * channels)
        }
    }

    /** Whether the priming gate is currently open. */
    fun isPrimed(): Boolean {
        lock.withLock {
            return primed
        }
    }

    /**
     * Reset the buffer to its initial empty state.
     * Called on turn changes to discard stale audio.
     */
    fun reset() {
        lock.withLock {
            writePos = 0
            readPos = 0
            count = 0
            primed = false
            endOfStream = false
        }
        // Telemetry is deliberately NOT reset here — the pipeline resets
        // telemetry at reconnect via [resetTelemetry].
    }

    /** Reset all telemetry counters to zero. */
    fun resetTelemetry() {
        totalWritten.set(0)
        totalRead.set(0)
        underrunCount.set(0)
        peakLevel.set(0)
    }
}
