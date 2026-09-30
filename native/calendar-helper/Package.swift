// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "calendar-helper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "calendar-helper", targets: ["CalendarHelper"])
    ],
    targets: [
        .executableTarget(
            name: "CalendarHelper",
            path: "Sources/CalendarHelper"
        )
    ]
)
