// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "speech-recognizer",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "speech-recognizer",
            path: "Sources/SpeechRecognizer"
        ),
    ]
)
