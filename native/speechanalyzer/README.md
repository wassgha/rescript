# native/speechanalyzer

macOS 26+ CLI helper that wraps Apple’s `SpeechAnalyzer` / `SpeechTranscriber`
for Rescript’s Electron shell.

```bash
# Requires macOS 26 + Xcode 26 SDK. Always build via Make (signing matters).
make -C native/speechanalyzer build
```

The signed binary is installed to `resources/bin/rescript-speechanalyzer` and
bundled into the Mac desktop app as an `extraResource`.

```bash
./resources/bin/rescript-speechanalyzer --check
./resources/bin/rescript-speechanalyzer /path/to/clip.m4a
```

Progress JSON lines are written to stderr; the final `{ type: "complete", words }`
payload goes to stdout.
