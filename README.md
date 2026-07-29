<p align="center">
  <img src="./screenshots/logo.png" alt="Rescript logo" width="96" />
</p>

# Rescript

**Edit video and audio like you edit text — fully offline, in your browser.**

**✨ Try it now: [wassgha.github.io/rescript](https://wassgha.github.io/rescript/)**

[![Follow @wassgha on X](https://img.shields.io/badge/Follow%20@wassgha-000000?logo=x&logoColor=white)](https://x.com/wassgha)

[![Rescript Demo](./screenshots/rescript.png)](https://wassgha.github.io/rescript/)

Rescript is an open-source, transcript-based media editor. Drop in a video or
audio file and it is transcribed locally with per-word timestamps and speaker
labels. Delete words in the transcript and the corresponding clip is cut from
the media. Export the final cut — without your file ever leaving your device.

- 🔒 **Private by design** — no server, no auth, no uploads; all media processing happens on-device
- 📝 **Word-level editing** — select words, press ⌫, the cut follows the text
- 📥 **Import your own transcript** — SRT / VTT / JSON with timestamps, or plain TXT synced to the audio
- 🧹 **Filler removal** — one-click cut of "um", "uh", and similar fillers
- 🗣️ **Speaker diarization** — the transcript is grouped by speaker
- 🎬 **Timeline** — waveform, word labels, cut regions, playhead, zoom
- ⚡ **Live preview** — playback skips your cuts in real time
- 📦 **In-browser export** — frame-accurate MP4 (video) or M4A (audio) with ffmpeg.wasm
- 🎧 **Audio files** — edit podcasts, voice notes, and interviews the same way as video

## Stack

| Piece | Tech |
| --- | --- |
| App | [Next.js](https://nextjs.org) + React + TypeScript + Tailwind |
| Transcription | [transformers.js](https://github.com/huggingface/transformers.js) running [`whisper-base_timestamped`](https://huggingface.co/onnx-community/whisper-base_timestamped) or [`whisper-small_timestamped`](https://huggingface.co/onnx-community/whisper-small_timestamped) (WebGPU with WASM fallback) in a Web Worker |
| Speaker labels | [`pyannote-segmentation-3.0`](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) (ONNX) |
| Media processing | [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) (multi-threaded) for audio extraction and export |
| State | zustand |

## Development

```bash
npm install     # also copies ffmpeg/onnxruntime WASM into public/vendor
npm run dev     # dev server
npm run build   # production build
npm run lint    # eslint
```

Open [http://localhost:3000](http://localhost:3000) and drop in a video with an
audio track.

> **Note on "offline":** the AI models (Whisper Base ~200 MB, or Small ~600 MB,
> plus a small speaker model) are downloaded from the Hugging Face Hub the
> *first* time you transcribe, then cached in browser storage. After that,
> everything — transcription, editing, export — works with the network fully
> disconnected. Your media and transcript never leave the device; the only
> third-party request the app makes is anonymous page analytics (Google
> Analytics), which fails silently when offline.

## How it works

1. **Extract** — ffmpeg.wasm decodes the audio track to mono 16 kHz PCM.
2. **Transcribe** — Whisper runs in a Web Worker with `return_timestamps: "word"`,
   streaming text as it goes; pyannote assigns a speaker to every word.
   Choose **Whisper Base**, **Whisper Small**, or **Import transcript**
   (SRT / VTT / JSON / TXT) on the homepage.
3. **Edit** — deleting words produces "cut ranges" of the original media. The
   preview player skips them in real time and the timeline shows them in red.
   **Remove fillers** cuts every detected "um" / "uh" / etc. in one click.
4. **Export** — the kept ranges are trimmed and concatenated with an ffmpeg
   filter graph and re-encoded (`libx264`/`aac`), so cuts are word-accurate.

## Browser support

A Chromium-based browser is recommended. The app requires `SharedArrayBuffer`
(served with COOP/COEP headers) and uses WebGPU for inference when available,
falling back to WASM otherwise.

## License

MIT

---

Built by [@wassgha](https://x.com/wassgha) — follow along on X for updates.
