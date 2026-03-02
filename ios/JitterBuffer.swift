import Foundation

/// Lock-based chunk queue for PCM audio (16-bit signed, little-endian).
///
/// Single producer (bridge thread) writes decoded PCM via `write()`.
/// Single consumer (scheduling thread) drains via `read()`.
/// All shared state is guarded by an NSLock.
///
/// Features:
///   - Chunk queue: incoming `[Int16]` chunks are stored by reference
///     (copy-on-write, zero actual copy since neither side mutates after write).
///     No fixed capacity limit.
///   - Priming gate: `read()` returns silence until `targetBufferMs` of audio has
///     accumulated (or `markEndOfStream()` force-primes so the tail drains).
///   - Silence-fill on underflow: when the buffer has fewer samples than the
///     consumer requested, the remainder is filled with silence and an underrun
///     is counted.
class JitterBuffer {
    private let sampleRate: Int
    private let channels: Int
    private let targetBufferMs: Int

    // ── Chunk queue storage ──────────────────────────────────────────────
    private var chunks: [[Int16]] = []
    private var readCursor: Int = 0   // offset into the head chunk
    private var count: Int = 0        // total live samples across all chunks

    // ── Priming gate ────────────────────────────────────────────────────
    private let primingSamples: Int
    private var primed: Bool = false

    // ── End-of-stream ───────────────────────────────────────────────────
    private var endOfStream: Bool = false

    // ── Lock ────────────────────────────────────────────────────────────
    private let lock = NSLock()

    // ── Telemetry ───────────────────────────────────────────────────────
    private(set) var totalWritten: Int64 = 0
    private(set) var totalRead: Int64 = 0
    private(set) var underrunCount: Int = 0
    private(set) var peakLevel: Int = 0

    init(sampleRate: Int, channels: Int, targetBufferMs: Int) {
        self.sampleRate = sampleRate
        self.channels = channels
        self.targetBufferMs = targetBufferMs
        self.primingSamples = (sampleRate * channels * targetBufferMs) / 1000
    }

    // ── Producer API ────────────────────────────────────────────────────

    /// Enqueue samples into the chunk queue.
    ///
    /// The array is stored directly (Swift CoW means zero actual copy
    /// as long as neither side mutates after the call).
    @discardableResult
    func write(samples: [Int16], offset: Int = 0, length: Int? = nil) -> Int {
        let len = length ?? samples.count
        lock.lock()
        defer { lock.unlock() }

        let chunk: [Int16]
        if offset == 0 && len == samples.count {
            chunk = samples
        } else {
            chunk = Array(samples[offset..<(offset + len)])
        }

        chunks.append(chunk)
        count += len

        // Update peak telemetry
        if count > peakLevel {
            peakLevel = count
        }
        totalWritten += Int64(len)

        // Check priming
        if !primed && count >= primingSamples {
            primed = true
        }

        return len
    }

    // ── Consumer API ────────────────────────────────────────────────────

    /// Fill `dest` with up to `length` samples from the chunk queue.
    ///
    /// - Not primed & no end-of-stream: fills with silence.
    /// - Primed: copies available samples; remainder is zero-filled
    ///   and an underrun is recorded.
    @discardableResult
    func read(dest: inout [Int16], offset: Int = 0, length: Int? = nil) -> Int {
        let len = length ?? dest.count
        lock.lock()
        defer { lock.unlock() }

        if !primed {
            for i in 0..<len {
                dest[offset + i] = 0
            }
            return len
        }

        var destPos = offset
        var remaining = len

        while remaining > 0 && !chunks.isEmpty {
            let chunk = chunks[0]
            let available = chunk.count - readCursor
            let toCopy = min(available, remaining)

            for i in 0..<toCopy {
                dest[destPos + i] = chunk[readCursor + i]
            }
            readCursor += toCopy
            destPos += toCopy
            remaining -= toCopy
            count -= toCopy

            if readCursor >= chunk.count {
                chunks.removeFirst()
                readCursor = 0
            }
        }

        // Silence-fill remainder on underflow
        if remaining > 0 {
            for i in 0..<remaining {
                dest[destPos + i] = 0
            }
            underrunCount += 1
        }

        totalRead += Int64(len)
        return len
    }

    // ── Control API ─────────────────────────────────────────────────────

    /// Mark that the producer will not write any more data for this turn.
    /// Force-primes the buffer so the consumer can drain whatever remains.
    func markEndOfStream() {
        lock.lock()
        defer { lock.unlock() }
        endOfStream = true
        if !primed {
            primed = true
        }
    }

    /// `true` after `markEndOfStream()` was called AND the buffer is empty.
    func isDrained() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return endOfStream && count == 0
    }

    /// Current buffer level in samples (snapshot).
    func availableSamples() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    /// Current buffer level converted to milliseconds.
    func bufferedMs() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let denom = sampleRate * channels
        guard denom > 0 else { return 0 }
        return (count * 1000) / denom
    }

    /// Whether the priming gate is currently open.
    func isPrimed() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return primed
    }

    /// Reset the buffer to its initial empty state.
    /// Called on turn changes to discard stale audio.
    func reset() {
        lock.lock()
        defer { lock.unlock() }
        chunks.removeAll()
        readCursor = 0
        count = 0
        primed = false
        endOfStream = false
    }

    /// Reset all telemetry counters to zero.
    func resetTelemetry() {
        lock.lock()
        defer { lock.unlock() }
        totalWritten = 0
        totalRead = 0
        underrunCount = 0
        peakLevel = 0
    }
}
