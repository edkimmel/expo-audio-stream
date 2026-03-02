package expo.modules.audiostream.pipeline

import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Lock-based chunk queue for PCM audio (16-bit signed, little-endian).
 *
 * Single producer (bridge thread) writes decoded PCM via [write].
 * Single consumer (write thread) drains via [read].
 * All shared state is guarded by a [ReentrantLock].
 *
 * Features:
 *   - Chunk queue: incoming [ShortArray] chunks are enqueued by reference
 *     (zero-copy on the producer side). No fixed capacity limit.
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
    private val targetBufferMs: Int
) {
    // ── Chunk queue storage ──────────────────────────────────────────────
    private val chunks = ArrayDeque<ShortArray>()
    private var readCursor = 0        // offset into the head chunk
    private var count = 0             // total live samples across all chunks

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
     * Enqueue [samples] into the chunk queue.
     *
     * When the full array is passed (offset == 0, length == samples.size),
     * the array reference is stored directly — zero copy. Otherwise a
     * subrange copy is made.
     *
     * @return number of samples enqueued (always [length]).
     */
    fun write(samples: ShortArray, offset: Int = 0, length: Int = samples.size): Int {
        lock.withLock {
            val chunk = if (offset == 0 && length == samples.size) {
                samples
            } else {
                samples.copyOfRange(offset, offset + length)
            }

            chunks.addLast(chunk)
            count += length

            // Update peak telemetry
            if (count > peakLevel.get()) {
                peakLevel.set(count)
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
     * Fill [dest] with up to [length] samples from the chunk queue.
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
                dest.fill(0, offset, offset + length)
                return length
            }

            var destPos = offset
            var remaining = length

            while (remaining > 0 && chunks.isNotEmpty()) {
                val chunk = chunks.peekFirst()
                val available = chunk.size - readCursor
                val toCopy = minOf(available, remaining)

                System.arraycopy(chunk, readCursor, dest, destPos, toCopy)
                readCursor += toCopy
                destPos += toCopy
                remaining -= toCopy
                count -= toCopy

                if (readCursor >= chunk.size) {
                    chunks.pollFirst()
                    readCursor = 0
                }
            }

            // Silence-fill remainder on underflow
            if (remaining > 0) {
                dest.fill(0, destPos, destPos + remaining)
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
            chunks.clear()
            readCursor = 0
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
