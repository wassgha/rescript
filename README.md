<p align="center">
  <img src="./screenshots/logo.png" alt="Rescript logo" width="96" /><br/>
  Edit video and audio like you edit text — fully offline, on your device.
</p>

# rescript.
[![Join the Discord](https://img.shields.io/badge/Discord-Join%20the%20server-5865F2?logo=discord&logoColor=white)](https://discord.gg/qJAhYFydat)
[![Follow @wassgha on X](https://img.shields.io/badge/Follow%20@wassgha-000000?logo=x&logoColor=white)](https://x.com/wassgha)

**✨ Try it in the browser [app.getrescript.com](https://app.getrescript.com/)** or download the [Desktop App](#download)

[![Rescript Demo](./screenshots/rescript.png)](https://getrescript.com/)

Rescript is an open-source, transcript-based media editor. Drop in a video or
audio file and it is transcribed locally with per-word timestamps and speaker
labels. Delete words in the transcript and the corresponding clip is cut from
the media. Export the final cut — without your file ever leaving your device.

## Download

<div align="center">

<a href="https://www.getrescript.com/download?platform=mac-arm"><img src="assets/download/download-macos-arm64.svg" alt="Download for macOS — Apple Silicon" height="48"></a> &nbsp; <a href="https://www.getrescript.com/download?platform=mac-intel"><img src="assets/download/download-macos-x64.svg" alt="Download for macOS — Intel" height="48"></a> &nbsp; <a href="https://www.getrescript.com/download?platform=windows"><img src="assets/download/download-windows.svg" alt="Download for Windows" height="48"></a> &nbsp; <a href="https://www.getrescript.com/download?platform=linux"><img src="assets/download/download-linux-appimage.svg" alt="Download the AppImage for Linux" height="48"></a> &nbsp; <a href="https://www.getrescript.com/download?platform=linux-deb"><img src="assets/download/download-debian-deb.svg" alt="Download the .deb for Linux" height="48"></a>

</div>

See the [Releases](https://github.com/wassgha/rescript/releases) page. Desktop
builds auto-update from GitHub Releases. Prefer the browser? Use the
[web app](https://getrescript.com/) — same editor, no install.

- 🔒 **Private by design** — no auth, no uploads; all media processing happens on-device
- 📝 **Word-level editing** — select words, press ⌫, the cut follows the text
- 📥 **Import your own transcript** — skip Whisper and edit with an SRT, VTT, or JSON caption file
- 📤 **Export hub** — video (MP4/WebM, 720p–4K), audio (M4A/MP3/WAV), transcript / captions (TXT/MD/DOCX/PDF/SRT/VTT/JSON, optional timestamps on documents), or NLE/DAW timeline (Resolve/Premiere/FCP/AAF/Reaper/Samplitude EDL)
- 🧹 **Filler removal** — one-click cut of "um", "uh", and similar fillers
- 🔇 **Silence removal** — one-click cut of pauses and dead air (≥0.3s)
- 🗣️ **Speaker diarization** — the transcript is grouped by speaker
- 🎬 **Timeline** — waveform, wordbar with draggable timing handles, Split,
  cut regions, playhead; scroll to zoom, side-scroll to pan
- ✂️ **Split & trim** — blade clips at the playhead; drag clip edges to refine
  cuts beyond word boundaries
- 🎯 **Word timing** — zoom in and drag a word's edges when ASR alignment is off
- 🔴 **Cut edges** — drag either edge of a cut to trim independently of Whisper
  timestamps; double-click to reset
- ⚡ **Live preview** — playback skips your cuts in real time
- 📦 **In-browser / desktop export** — frame-accurate re-encode with ffmpeg.wasm
- 🎞️ **NLE / DAW timeline export** — DaVinci Resolve / Premiere XML, Final Cut FCPXML, Pro Tools/Logic AAF, Reaper `.rpp`, Samplitude `.edl`
- 🎧 **Audio files** — edit podcasts, voice notes, and interviews the same way as video
- 🖥️ **Desktop app** — macOS, Windows, and Linux via Electron (signed + notarized on Mac)

## Stack

| Piece | Tech |
| --- | --- |
| App | [Next.js](https://nextjs.org) + React + TypeScript + Tailwind |
| Desktop | [Electron](https://www.electronjs.org/) + [electron-builder](https://www.electron.build/) (auto-update from GitHub Releases) |
| Transcription | [transformers.js](https://github.com/huggingface/transformers.js) running [`whisper-base_timestamped`](https://huggingface.co/onnx-community/whisper-base_timestamped) or [`whisper-small_timestamped`](https://huggingface.co/onnx-community/whisper-small_timestamped) (WebGPU with WASM fallback) in a Web Worker |
| Speaker labels | [`pyannote-segmentation-3.0`](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) (ONNX) |
| Media processing | [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) (multi-threaded) for audio extraction and export |
| State | zustand |

## Development

```bash
npm install     # also copies ffmpeg/onnxruntime WASM into public/vendor
npm run dev     # Next.js web app (http://localhost:3000)
npm run electron:dev   # Electron shell + Next.js dev server
npm run build   # production web build
npm run dist    # unsigned desktop installers into dist/
npm run lint    # eslint
```

For desktop packaging, signing, and cutting releases, see
[RELEASING.md](./RELEASING.md).

## How it works

[![Rescript Promo](./screenshots/rescript-2.png)](https://getrescript.com/)

1. **Extract** — ffmpeg.wasm decodes the audio track to mono 16 kHz PCM.
2. **Transcribe** — Whisper runs in a Web Worker with `return_timestamps: "word"`,
   streaming text as it goes; pyannote assigns a speaker to every word.
   Choose **Whisper Base**, **Whisper Small**, or **Import transcript**
   (SRT / VTT / JSON) on the homepage.
3. **Edit** — deleting words produces "cut ranges" of the original media. The
   preview player skips them in real time and the timeline shows them in red.
   **Remove fillers** cuts every detected "um" / "uh" / etc. in one click.
   **Remove silences** cuts pauses and dead air of 0.3s or longer.
4. **Export** — the kept ranges are trimmed and concatenated with an ffmpeg
   filter graph and re-encoded (`libx264`/`aac`), so cuts are word-accurate.

## Browser support

A Chromium-based browser is recommended for the web app. It requires
`SharedArrayBuffer` (served with COOP/COEP headers) and uses WebGPU for
inference when available, falling back to WASM otherwise. The desktop app
bundles Chromium via Electron and sets the same isolation headers on its
`app://` protocol.

## Telemetry

By default, Rescript reports anonymous usage stats and crash reports so we can
tell how many people actually use it, which features are worth the maintenance,
and what's breaking. You can turn both off in **Settings → Privacy → Help
improve the app**, which stops them immediately and permanently on that install. Crash reports go to Sentry and carry a stack trace, the app version, and the platform.

## License

Copyright (c) 2026 Wassim Gharbi and Rescript contributors.

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).
You may use, modify, and share Rescript for noncommercial purposes only, and
you must retain the required copyright notice. Commercial use (including
reselling or redistributing the software for a fee) is not permitted under
this license. Contact the author for commercial licensing.

Prior releases published under the MIT License remain available under MIT for
those versions only.

---

[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-111?style=flat-square)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Web%20·%20macOS%20·%20Windows%20·%20Linux-111?style=flat-square)](#download)
[![Electron](https://img.shields.io/badge/Electron-42-111?style=flat-square&logo=electron&logoColor=9FEAF9)](https://www.electronjs.org/)
[![Stars](https://img.shields.io/github/stars/wassgha/rescript?style=flat-square&color=111)](https://github.com/wassgha/rescript/stargazers)
[![Latest release](https://img.shields.io/github/v/release/wassgha/rescript?label=latest%20release&sort=semver&style=flat-square&color=111)](https://github.com/wassgha/rescript/releases/latest)

Built by [@wassgha](https://x.com/wassgha) — follow along on X for updates, or
come say hi in the [Discord](https://discord.com/invite/qJAhYFydat).
