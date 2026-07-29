// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "rescript-speechanalyzer",
  platforms: [
    .macOS("26.0"),
  ],
  products: [
    .executable(name: "rescript-speechanalyzer", targets: ["RescriptSpeechAnalyzer"]),
  ],
  targets: [
    .executableTarget(
      name: "RescriptSpeechAnalyzer",
      path: "Sources/RescriptSpeechAnalyzer"
    ),
  ]
)
