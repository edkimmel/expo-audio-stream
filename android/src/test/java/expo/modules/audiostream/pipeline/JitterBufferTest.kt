package expo.modules.audiostream.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Plain-JVM unit tests for [JitterBuffer] — the buffer has no Android
 * dependencies, so these run with `gradlew testDebugUnitTest` and no
 * emulator or Robolectric.
 *
 * Convention used throughout: sampleRate=1000 Hz, mono, targetBufferMs=100
 * → priming gate opens at 100 samples.
 */
class JitterBufferTest {

    private fun buffer(targetBufferMs: Int = 100) =
        JitterBuffer(sampleRate = 1000, channels = 1, targetBufferMs = targetBufferMs)

    private fun samples(range: IntRange): ShortArray =
        ShortArray(range.count()) { (range.first + it).toShort() }

    // ── Priming gate ────────────────────────────────────────────────────

    @Test
    fun `read returns silence until priming threshold is reached`() {
        val buf = buffer()
        buf.write(samples(1..50)) // below 100-sample gate

        val dest = ShortArray(10) { 99 }
        buf.read(dest)

        assertFalse(buf.isPrimed())
        assertTrue(dest.all { it == 0.toShort() })
        // Silence reads must not consume buffered audio
        assertEquals(50, buf.availableSamples())
    }

    @Test
    fun `priming gate opens once enough audio accumulates`() {
        val buf = buffer()
        buf.write(samples(1..100))
        assertTrue(buf.isPrimed())

        val dest = ShortArray(10)
        buf.read(dest)
        assertEquals(samples(1..10).toList(), dest.toList())
    }

    @Test
    fun `markEndOfStream force-primes so the tail drains`() {
        val buf = buffer()
        buf.write(samples(1..30)) // never reaches the gate
        buf.markEndOfStream()
        assertTrue(buf.isPrimed())

        val dest = ShortArray(30)
        buf.read(dest)
        assertEquals(samples(1..30).toList(), dest.toList())
        assertTrue(buf.isDrained())
    }

    // ── FIFO integrity ──────────────────────────────────────────────────

    @Test
    fun `sample order is preserved across chunk boundaries and odd read sizes`() {
        val buf = buffer(targetBufferMs = 0) // gate open immediately
        buf.write(samples(1..7))
        buf.write(samples(8..12))
        buf.write(samples(13..20))

        val out = mutableListOf<Short>()
        val dest = ShortArray(3)
        repeat(6) {
            buf.read(dest)
            out.addAll(dest.toList())
        }
        // 18 real samples then zero-fill
        assertEquals(samples(1..18).toList(), out.take(18))
        assertTrue(out.drop(18).all { it == 0.toShort() })
    }

    @Test
    fun `write with offset copies only the subrange`() {
        val buf = buffer(targetBufferMs = 0)
        val src = samples(1..10)
        buf.write(src, offset = 4, length = 3) // samples 5,6,7

        val dest = ShortArray(3)
        buf.read(dest)
        assertEquals(listOf<Short>(5, 6, 7), dest.toList())
    }

    // ── Underrun accounting ─────────────────────────────────────────────

    @Test
    fun `underrun is counted when primed and data runs out`() {
        val buf = buffer(targetBufferMs = 0)
        buf.write(samples(1..5))

        val dest = ShortArray(10)
        buf.read(dest)

        assertEquals(1, buf.underrunCount.get())
        assertEquals(samples(1..5).toList(), dest.take(5))
        assertTrue(dest.drop(5).all { it == 0.toShort() })
    }

    @Test
    fun `zero-fill after end of stream is not an underrun`() {
        val buf = buffer(targetBufferMs = 0)
        buf.write(samples(1..5))
        buf.markEndOfStream()

        val dest = ShortArray(10)
        buf.read(dest)

        assertEquals(0, buf.underrunCount.get())
        assertTrue(buf.isDrained())
    }

    // ── Reset semantics ─────────────────────────────────────────────────

    @Test
    fun `reset discards audio and closes the gate but keeps telemetry`() {
        val buf = buffer()
        buf.write(samples(1..150))
        buf.markEndOfStream()
        buf.reset()

        assertEquals(0, buf.availableSamples())
        assertFalse(buf.isPrimed())
        assertFalse(buf.isDrained())
        // Telemetry survives reset (cleared separately via resetTelemetry)
        assertEquals(150L, buf.totalWritten.get())

        buf.resetTelemetry()
        assertEquals(0L, buf.totalWritten.get())
        assertEquals(0, buf.peakLevel.get())
    }

    // ── Telemetry ───────────────────────────────────────────────────────

    @Test
    fun `telemetry tracks written, read, and peak levels`() {
        val buf = buffer(targetBufferMs = 0)
        buf.write(samples(1..40))
        buf.write(samples(41..100))
        assertEquals(100L, buf.totalWritten.get())
        assertEquals(100, buf.peakLevel.get())
        assertEquals(100, buf.bufferedMs()) // 100 samples @ 1kHz mono

        val dest = ShortArray(60)
        buf.read(dest)
        assertEquals(60L, buf.totalRead.get())
        assertEquals(40, buf.availableSamples())
    }
}
