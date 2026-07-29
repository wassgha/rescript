import AVFoundation
import CoreMedia
import Foundation
import Speech

// Minimal CLI that wraps Apple's SpeechAnalyzer / SpeechTranscriber
// (macOS 26+) for Rescript's Electron shell.
//
// Usage:
//   rescript-speechanalyzer --check [--locale en-US]
//   rescript-speechanalyzer <audio-or-video-path> [--locale en-US]
//
// Progress JSON lines go to stderr; the final result JSON goes to stdout.
// Lessons encoded here come from the dictamac / steno projects:
//   - analyzer lifecycle MUST run on @MainActor
//   - keep the main RunLoop alive (dispatchMain) or finals never arrive
//   - AssetInventory.reserve(locale:) is required or analyzeSequence hangs
//   - use finalizeAndFinishThroughEndOfInput(), not finalize(through: infinity)
//   - ad-hoc codesign with JIT + disable-library-validation entitlements

@main
enum RescriptSpeechAnalyzerMain {
  static func main() {
    let args = Array(CommandLine.arguments.dropFirst())
    if args.contains("-h") || args.contains("--help") {
      fputs(
        """
        Usage:
          rescript-speechanalyzer --check [--locale <id>]
          rescript-speechanalyzer <file> [--locale <id>]

        """,
        stderr
      )
      exit(0)
    }

    let locale = parseLocale(from: args)
    let checkOnly = args.contains("--check")
    let filePath = positionalFilePath(from: args)

    // Kick off async work, then park on the main RunLoop so SpeechAnalyzer
    // can deliver results (see dictamac DefaultTranscriber notes).
    Task {
      do {
        if checkOnly {
          let payload = try await checkAvailability(locale: locale)
          printJSON(payload)
          exit(0)
        }
        guard let filePath else {
          throw HelperError.usage("missing audio/video file path")
        }
        let payload = try await transcribe(path: filePath, locale: locale)
        printJSON(payload)
        exit(0)
      } catch let err as HelperError {
        printJSON([
          "type": "error",
          "message": err.message,
          "code": err.code,
        ])
        exit(Int32(err.exitCode))
      } catch {
        printJSON([
          "type": "error",
          "message": error.localizedDescription,
          "code": "unknown",
        ])
        exit(1)
      }
    }
    dispatchMain()
  }
}

// MARK: - CLI helpers

enum HelperError: Error {
  case usage(String)
  case unavailable(String)
  case file(String)
  case transcribe(String)

  var message: String {
    switch self {
    case .usage(let m), .unavailable(let m), .file(let m), .transcribe(let m):
      return m
    }
  }

  var code: String {
    switch self {
    case .usage: return "usage"
    case .unavailable: return "unavailable"
    case .file: return "file"
    case .transcribe: return "transcribe"
    }
  }

  var exitCode: Int {
    switch self {
    case .usage: return 2
    case .unavailable: return 67
    case .file: return 66
    case .transcribe: return 1
    }
  }
}

func parseLocale(from args: [String]) -> Locale {
  if let idx = args.firstIndex(of: "--locale"), args.index(after: idx) < args.endIndex {
    return Locale(identifier: args[args.index(after: idx)])
  }
  return Locale.current
}

func positionalFilePath(from args: [String]) -> String? {
  var skipNext = false
  for arg in args {
    if skipNext {
      skipNext = false
      continue
    }
    if arg == "--locale" {
      skipNext = true
      continue
    }
    if arg.hasPrefix("-") { continue }
    return arg
  }
  return nil
}

func printJSON(_ value: Any) {
  guard JSONSerialization.isValidJSONObject(value),
        let data = try? JSONSerialization.data(withJSONObject: value),
        let line = String(data: data, encoding: .utf8)
  else {
    fputs("{\"type\":\"error\",\"message\":\"failed to encode JSON\"}\n", stderr)
    return
  }
  print(line)
  fflush(stdout)
}

func progress(_ message: String, value: Double? = nil) {
  var payload: [String: Any] = ["type": "progress", "message": message]
  if let value { payload["value"] = value }
  else { payload["value"] = NSNull() }
  if let data = try? JSONSerialization.data(withJSONObject: payload),
     let line = String(data: data, encoding: .utf8)
  {
    fputs(line + "\n", stderr)
    fflush(stderr)
  }
}

func localeIdentifier(_ locale: Locale) -> String {
  let id = locale.identifier(.bcp47)
  return id.isEmpty ? locale.identifier : id
}

// MARK: - Availability

func checkAvailability(locale: Locale) async throws -> [String: Any] {
  guard #available(macOS 26.0, *) else {
    return [
      "type": "check",
      "available": false,
      "reason": "SpeechAnalyzer requires macOS 26 or later.",
    ]
  }
  return try await checkAvailabilityModern(locale: locale)
}

@available(macOS 26.0, *)
func checkAvailabilityModern(locale: Locale) async throws -> [String: Any] {
  // Touch the type so we fail closed if Speech framework symbols resolve
  // but the runtime refuses to construct a transcriber.
  _ = SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: [],
    attributeOptions: [.audioTimeRange]
  )
  let installed = SpeechTranscriber.installedLocales
  let supported = SpeechTranscriber.supportedLocales
  return [
    "type": "check",
    "available": true,
    "locale": localeIdentifier(locale),
    "installedLocales": installed.map { localeIdentifier($0) },
    "supportedLocales": Array(supported.prefix(32)).map { localeIdentifier($0) },
  ]
}

// MARK: - Transcription entry

func transcribe(path: String, locale: Locale) async throws -> [String: Any] {
  guard #available(macOS 26.0, *) else {
    throw HelperError.unavailable("SpeechAnalyzer requires macOS 26 or later.")
  }
  return try await transcribeModern(path: path, locale: locale)
}

// MARK: - Model bootstrap + analyze

@available(macOS 26.0, *)
func ensureModel(for locale: Locale) async throws {
  let probe = SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: [],
    attributeOptions: []
  )
  let status = await AssetInventory.status(forModules: [probe])
  switch status {
  case .installed:
    break
  case .supported, .downloading:
    progress("Downloading on-device speech model…")
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
      try await request.downloadAndInstall()
    }
  case .unsupported:
    throw HelperError.unavailable(
      "SpeechAnalyzer has no model for locale \(localeIdentifier(locale)). Install one in System Settings."
    )
  @unknown default:
    throw HelperError.unavailable(
      "SpeechAnalyzer reported an unknown asset status for locale \(localeIdentifier(locale))."
    )
  }

  // Without reserve(), analyzeSequence hangs forever.
  do {
    _ = try await AssetInventory.reserve(locale: locale)
  } catch {
    throw HelperError.unavailable(
      "Could not reserve SpeechAnalyzer locale \(localeIdentifier(locale)): \(error.localizedDescription)"
    )
  }
}

@available(macOS 26.0, *)
func transcribeModern(path: String, locale: Locale) async throws -> [String: Any] {
  let url = URL(fileURLWithPath: path)
  guard FileManager.default.fileExists(atPath: url.path) else {
    throw HelperError.file("File not found: \(path)")
  }

  progress("Preparing SpeechAnalyzer…")
  try await ensureModel(for: locale)

  let audioFile: AVAudioFile
  do {
    audioFile = try AVAudioFile(forReading: url)
  } catch {
    throw HelperError.file("Could not decode audio from \(path): \(error.localizedDescription)")
  }

  let transcriber = SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: [],
    attributeOptions: [.audioTimeRange]
  )
  let analyzer = SpeechAnalyzer(modules: [transcriber])

  progress("Transcribing with SpeechAnalyzer…", value: 0)

  async let analyzedEnd: CMTime? = Task { @MainActor in
    let last = try await analyzer.analyzeSequence(from: audioFile)
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    return last
  }.value

  var words: [[String: Any]] = []
  var nextId = 0
  do {
    for try await result in transcriber.results {
      guard result.isFinal else { continue }
      let chunk = wordsFromResult(result, startingId: nextId)
      nextId += chunk.count
      words.append(contentsOf: chunk)
      if let last = chunk.last, let end = last["end"] as? Double, end > 0 {
        let approxDuration =
          Double(audioFile.length) / max(audioFile.processingFormat.sampleRate, 1)
        if approxDuration > 0 {
          progress("Transcribing with SpeechAnalyzer…", value: min(0.99, end / approxDuration))
        }
      }
    }
  } catch {
    _ = try? await analyzedEnd
    throw HelperError.transcribe(error.localizedDescription)
  }

  let end = try await analyzedEnd
  let duration: Double = {
    if let end, end.isNumeric, end.seconds.isFinite, end.seconds > 0 {
      return end.seconds
    }
    let frames = Double(audioFile.length)
    let rate = audioFile.processingFormat.sampleRate
    if rate > 0, frames > 0 { return frames / rate }
    return (words.last?["end"] as? Double) ?? 0
  }()

  return [
    "type": "complete",
    "locale": localeIdentifier(locale),
    "duration": duration,
    "model": "SpeechAnalyzer/macOS26",
    "words": words,
  ]
}

@available(macOS 26.0, *)
func wordsFromResult(_ result: SpeechTranscriber.Result, startingId: Int) -> [[String: Any]] {
  var out: [[String: Any]] = []
  var id = startingId

  // Prefer per-run audioTimeRange (word/phrase level) when present.
  var emittedFromRuns = false
  for run in result.text.runs {
    guard let range = run.audioTimeRange else { continue }
    let start = seconds(range.start)
    let end = seconds(range.end)
    let text = String(run.text).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, end >= start else { continue }
    emittedFromRuns = true
    for piece in splitWords(text, start: start, end: end) {
      out.append([
        "id": id,
        "text": piece.text,
        "start": piece.start,
        "end": piece.end,
        "speaker": 0,
        "deleted": false,
      ])
      id += 1
    }
  }

  if emittedFromRuns { return out }

  // Fallback: one timed segment → split words proportionally.
  let start = seconds(result.range.start)
  let end = seconds(result.range.end)
  let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
  guard !text.isEmpty else { return out }
  for piece in splitWords(text, start: start, end: max(end, start)) {
    out.append([
      "id": id,
      "text": piece.text,
      "start": piece.start,
      "end": piece.end,
      "speaker": 0,
      "deleted": false,
    ])
    id += 1
  }
  return out
}

func seconds(_ time: CMTime) -> Double {
  guard time.isNumeric else { return 0 }
  let value = time.seconds
  return value.isFinite ? value : 0
}

struct TimedWord {
  let text: String
  let start: Double
  let end: Double
}

func splitWords(_ text: String, start: Double, end: Double) -> [TimedWord] {
  let tokens = text.split { $0.isWhitespace }.map(String.init).filter { !$0.isEmpty }
  guard !tokens.isEmpty else { return [] }
  if tokens.count == 1 {
    return [TimedWord(text: tokens[0], start: start, end: max(end, start))]
  }
  let span = max(end - start, 0)
  let step = span / Double(tokens.count)
  return tokens.enumerated().map { i, token in
    let s = start + Double(i) * step
    let e = i == tokens.count - 1 ? max(end, s) : start + Double(i + 1) * step
    return TimedWord(text: token, start: s, end: e)
  }
}
