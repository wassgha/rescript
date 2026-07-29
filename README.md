<p align="center">
  <img src="./screenshots/logo.png" alt="Rescript logo" width="96" />
</p>

# rescript.

Edit video and audio like you edit text — fully offline, on your device.

**✨ Try it in the browser [wassgha.github.io/rescript](https://wassgha.github.io/rescript/)** or download the [Desktop App](#download)

[![Follow @wassgha on X](https://img.shields.io/badge/Follow%20@wassgha-000000?logo=x&logoColor=white)](https://x.com/wassgha)

[![Rescript Demo](./screenshots/rescript.png)](https://wassgha.github.io/rescript/)

Rescript is an open-source, transcript-based media editor. Drop in a video or
audio file and it is transcribed locally with per-word timestamps and speaker
labels. Delete words in the transcript and the corresponding clip is cut from
the media. Export the final cut — without your file ever leaving your device.

## Download

<div align="center">

<a href="https://github.com/wassgha/rescript/releases/latest/download/Rescript-mac-arm64.dmg"><img src="assets/download/download-macos-arm64.svg" alt="Download for macOS — Apple Silicon" height="48"></a> &nbsp; <a href="https://github.com/wassgha/rescript/releases/latest/download/Rescript-mac-x64.dmg"><img src="assets/download/download-macos-x64.svg" alt="Download for macOS — Intel" height="48"></a> &nbsp; <a href="https://github.com/wassgha/rescript/releases/latest/download/Rescript-Setup.exe"><img src="assets/download/download-windows.svg" alt="Download for Windows" height="48"></a> &nbsp; <a href="https://github.com/wassgha/rescript/releases/latest/download/Rescript-linux.AppImage"><img src="assets/download/download-linux-appimage.svg" alt="Download the AppImage for Linux" height="48"></a>

</div>

See the [Releases](https://github.com/wassgha/rescript/releases) page. Desktop
builds auto-update from GitHub Releases. Prefer the browser? Use the
[web app](https://wassgha.github.io/rescript/) — same editor, no install.

- 🔒 **Private by design** — no server, no auth, no uploads; all media processing happens on-device
- 📝 **Word-level editing** — select words, press ⌫, the cut follows the text
- 📥 **Import your own transcript** — skip Whisper and edit with an SRT, VTT, or JSON caption file
- 🧹 **Filler removal** — one-click cut of "um", "uh", and similar fillers
- 🗣️ **Speaker diarization** — the transcript is grouped by speaker
- 🎬 **Timeline** — waveform, wordbar with draggable timing handles, Split,
  cut regions, playhead; scroll to zoom, side-scroll to pan
- ✂️ **Split & trim** — blade clips at the playhead; drag clip edges to refine
  cuts beyond word boundaries
- 🎯 **Word timing** — zoom in and drag a word's edges when ASR alignment is off
- 🔴 **Cut edges** — drag either edge of a cut to trim independently of Whisper
  timestamps; double-click to reset
- ⚡ **Live preview** — playback skips your cuts in real time
- 📦 **In-browser / desktop export** — frame-accurate MP4 (video) or M4A (audio) with ffmpeg.wasm
- 🎧 **Audio files** — edit podcasts, voice notes, and interviews the same way as video
- 🖥️ **Desktop app** — macOS, Windows, and Linux via Electron (signed + notarized on Mac)
- 🍎 **SpeechAnalyzer** — optional on-device transcription via Apple’s Speech framework (macOS 26+, desktop)

## Stack

| Piece | Tech |
| --- | --- |
| App | [Next.js](https://nextjs.org) + React + TypeScript + Tailwind |
| Desktop | [Electron](https://www.electronjs.org/) + [electron-builder](https://www.electron.build/) (auto-update from GitHub Releases); optional macOS [SpeechAnalyzer](https://developer.apple.com/documentation/speech) helper |
| Transcription | [transformers.js](https://github.com/huggingface/transformers.js) Whisper (WebGPU/WASM) in a Web Worker, **or** Apple SpeechAnalyzer on macOS 26+ desktop |
| Speaker labels | [`pyannote-segmentation-3.0`](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) (ONNX) |
| Media processing | [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) (multi-threaded) for audio extraction and export |
| State | zustand |

## Development

```bash
npm install     # also copies ffmpeg/onnxruntime WASM into public/vendor
npm run dev     # Next.js web app (http://localhost:3000)
npm run electron:dev   # Electron shell + Next.js dev server
# Optional (macOS 26+ only): build the SpeechAnalyzer helper
make -C native/speechanalyzer build
npm run build   # production web build
npm run dist    # unsigned desktop installers into dist/
npm run lint    # eslint
```

Open [http://localhost:3000](http://localhost:3000) and drop in a video with an
audio track. For desktop packaging, signing, and cutting releases, see
[RELEASING.md](./RELEASING.md).

> **Note on "offline":** the AI models (Whisper Base ~200 MB, or Small ~600 MB,
> plus a small speaker model) are downloaded from the Hugging Face Hub the
> *first* time you transcribe, then cached in browser / app storage. After that,
> everything — transcription, editing, export — works with the network fully
> disconnected. Your media and transcript never leave the device; the only
> third-party request the app makes is anonymous page analytics (Google
> Analytics), which fails silently when offline.

## How it works

1. **Extract** — ffmpeg.wasm decodes the audio track to mono 16 kHz PCM.
2. **Transcribe** — Whisper runs in a Web Worker with `return_timestamps: "word"`,
   streaming text as it goes; pyannote assigns a speaker to every word.
   On the macOS desktop app you can instead choose **SpeechAnalyzer** (Apple’s
   on-device model). Or choose **Import transcript** (SRT / VTT / JSON).
3. **Edit** — deleting words produces "cut ranges" of the original media. The
   preview player skips them in real time and the timeline shows them in red.
   **Remove fillers** cuts every detected "um" / "uh" / etc. in one click.
4. **Export** — the kept ranges are trimmed and concatenated with an ffmpeg
   filter graph and re-encoded (`libx264`/`aac`), so cuts are word-accurate.

## Browser support

A Chromium-based browser is recommended for the web app. It requires
`SharedArrayBuffer` (served with COOP/COEP headers) and uses WebGPU for
inference when available, falling back to WASM otherwise. The desktop app
bundles Chromium via Electron and sets the same isolation headers on its
`app://` protocol.

## License

MIT


[![License: MIT](https://img.shields.io/badge/license-MIT-111?style=flat-square)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Web%20·%20macOS%20·%20Windows%20·%20Linux-111?style=flat-square)](#download)
[![Electron](https://img.shields.io/badge/Electron-42-111?style=flat-square&logo=electron&logoColor=9FEAF9)](https://www.electronjs.org/)
[![Stars](https://img.shields.io/github/stars/wassgha/rescript?style=flat-square&color=111)](https://github.com/wassgha/rescript/stargazers)
[![Latest release](https://img.shields.io/github/v/release/wassgha/rescript?label=latest%20release&sort=semver&style=flat-square&color=111)](https://github.com/wassgha/rescript/releases/latest)


---

Built by [@wassgha](https://x.com/wassgha) — follow along on X for updates.
