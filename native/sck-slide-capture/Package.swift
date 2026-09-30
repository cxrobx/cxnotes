// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "sck-slide-capture",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "sck-slide-capture", targets: ["sck-slide-capture"])
    ],
    targets: [
        .executableTarget(
            name: "sck-slide-capture",
            path: "Sources"
        )
    ]
)
