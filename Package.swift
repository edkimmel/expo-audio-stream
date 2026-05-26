// swift-tools-version:5.9
import PackageDescription

// Swift Package used only to unit-test the library's pure, dependency-free Swift
// (no Expo/AVFoundation). The same sources are compiled into the production
// CocoaPod via the podspec's recursive glob — this package is an additional,
// isolated way to run them as real XCTest with `swift test` (no CocoaPods,
// no simulator, no ExpoModulesCore). It is inert to npm/CocoaPods/Expo builds.
let package = Package(
    name: "ExpoAudioStreamSwift",
    platforms: [.macOS(.v12), .iOS(.v15)],
    targets: [
        .target(name: "AudioStreamCore", path: "ios/Core"),
        .testTarget(
            name: "AudioStreamCoreTests",
            dependencies: ["AudioStreamCore"],
            path: "ios/Tests"
        ),
    ]
)
