package expo.modules.audiostream.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class JitterBufferTest {
    @Test
    fun writeBuffersSamplesAndPrimes() {
        // 1000 Hz mono, prime gate at 10 ms => 10 samples.
        val buffer = JitterBuffer(sampleRate = 1000, channels = 1, targetBufferMs = 10)

        val written = buffer.write(ShortArray(20) { it.toShort() })

        assertEquals(20, written)
        assertEquals(20, buffer.availableSamples())
        assertTrue("buffer should be primed after exceeding target", buffer.isPrimed())
    }
}
