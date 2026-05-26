import XCTest
@testable import AudioStreamCore

final class PCMConversionTests: XCTestCase {
    func testInt16ToFloatConversion() {
        XCTAssertEqual(PCMConversion.int16ToFloat(0), 0.0, accuracy: 0.0001)
        XCTAssertEqual(PCMConversion.int16ToFloat(32767), 0.99996948, accuracy: 0.0001)
        XCTAssertEqual(PCMConversion.int16ToFloat(-32768), -1.0, accuracy: 0.0001)
    }
}
