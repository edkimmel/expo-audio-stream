import Foundation

/// Pure PCM sample conversions, isolated so they can be unit-tested without
/// AVFoundation or audio hardware.
enum PCMConversion {
    /// Convert a signed 16-bit PCM sample to a normalized Float in [-1.0, 1.0).
    static func int16ToFloat(_ sample: Int16) -> Float {
        return Float(sample) / 32768.0
    }
}
