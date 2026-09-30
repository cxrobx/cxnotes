// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "call-audio-tap",
    // Core Audio process taps arrived in macOS 14.2. The package still builds
    // for 13 so the app's minimum does not move; the helper checks at runtime
    // and reports itself unavailable on anything older.
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "call-audio-tap", targets: ["call-audio-tap"])
    ],
    targets: [
        .executableTarget(
            name: "call-audio-tap",
            path: "Sources"
        )
    ]
)
