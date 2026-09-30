// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "sck-audio-capture",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "sck-audio-capture", targets: ["sck-audio-capture"])
    ],
    targets: [
        .executableTarget(
            name: "sck-audio-capture",
            path: "Sources"
        )
    ]
)
