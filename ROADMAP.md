# Roadmap

User-facing progress for Rescript. Items are marked done when they shipped to
`main` (web and/or desktop). Internal refactors and CI-only work are omitted.

## Done

### Core editor
- [x] Offline transcript-based editor in the browser (no auth, no uploads)
- [x] Upload → local Whisper transcription with per-word timestamps
- [x] Speaker diarization (pyannote) with speaker-grouped transcript
- [x] Cut / restore by selecting words (⌫, floating toolbar); undo / redo
- [x] Live preview that skips cut ranges in real time
- [x] Timeline with waveform, ruler, word labels, cut regions, playhead, and zoom
- [x] In-browser export to MP4 (ffmpeg.wasm, word-accurate cuts)
- [x] Continuous selection highlight and Descript-style timeline word pills
- [x] Cache-aware model loading labels; speaker model preloaded during transcription
- [x] Monotonic download / transcription progress

### Editing & transcript tools
- [x] Correct misrecognized words (selection → Correct popover; timings redistributed)
- [x] One-click **Remove fillers** (um / uh / etc.)
- [x] One-click **Remove silences** (pauses / dead air ≥ 0.3s)
- [x] Import your own transcript (SRT / VTT / JSON) instead of running Whisper
- [x] Import cancel UX (no stuck selector / blocked media drop)
- [x] Manual speaker controls (rename, change, add, move label, merge, remove)

### Transcription quality & models
- [x] Whisper Base and Whisper Small selectable on upload
- [x] Silence skip (VAD) and hallucination mitigations for longer files
- [x] Multi-speaker clips no longer drop the second speaker after silence-skip
- [x] Smoother transcription progress across Whisper windows
- [x] Better word↔audio alignment (speech-onset anchoring / lag correction)
- [x] Multilingual transcription (language selector; English + German, with DE fillers)
- [x] WebGPU → WASM fallback when the GPU is lost (e.g. Windows screen lock)
- [x] Graceful handling of media with no audio track

### Audio & media kinds
- [x] Edit audio files (mp3 / wav / m4a / …) the same way as video
- [x] Audio-only workspace (hide empty video preview; transcript gets full width)
- [x] Audio export (M4A and additional formats via the export dialog)

### Timeline editing (Descript-style)
- [x] Drag word start / end to fix ASR bleed
- [x] Split at playhead (`S` / Split) into selectable clips
- [x] Clip trim handles (manual cuts; covered words marked cut in the transcript)
- [x] Draggable cut edges; scrub while dragging; double-click to reset
- [x] Scroll to zoom / side-scroll to pan
- [x] Timeline ↔ transcript selection sync; splits reflected in the transcript
- [x] Word chips visible at all zoom levels
- [x] Waveform peak clamping on the timeline

### Layout, mobile & chrome
- [x] Mobile-friendly stacked editor layout
- [x] Upload screen scrollable on short / mobile viewports
- [x] Resizable transcript / preview split on desktop (persisted)
- [x] Transcript scroll rail with tick marks and edge fades
- [x] Light / Dark appearance in Settings (persisted; default light)
- [x] Settings menu (appearance + community / support links)
- [x] Social links (Discord, X, GitHub)
- [x] Mobile menus stay on-screen (Floating UI flip / shift)
- [x] Smoother transcript text selection while dragging
- [x] Spacebar play / pause reliability and media-control polish

### Projects & persistence
- [x] Auto-save projects to IndexedDB
- [x] Recent projects list on the home screen (open / delete)

### Export
- [x] Tabbed export dialog: **Video**, **Audio**, **Transcript**, **Subtitles**, **Timeline**
- [x] Video: format (MP4 / WebM) and resolution options
- [x] Audio: M4A / MP3 / WAV (including from video projects)
- [x] Transcript: plain text, Markdown, DOCX, or PDF (optional timestamps; cuts removed)
- [x] Subtitles: SRT / VTT (edited timeline) or JSON (full words for re-import)
- [x] Timeline: Resolve / Premiere XML, Final Cut FCPXML, Pro Tools AAF, Reaper `.rpp`, Samplitude `.edl`

### Desktop & distribution
- [x] Live web app on GitHub Pages
- [x] Electron desktop app for macOS, Windows, and Linux
- [x] Signed / notarized Mac builds; auto-update from GitHub Releases
- [x] Desktop chrome polish (traffic lights, window sizing, animated logo / top bar)

## Next

- [ ] **Parakeet TDT v3** as an optional transcription backend (faster / more accurate word timings)
- [ ] Fix remaining drift / lag and push word timestamps closer to true speech boundaries
- [ ] In-app transcript editor (richer inline editing beyond the Correct popover)
- [ ] **Regenerate** — text-to-speech with accurate voice cloning so rewritten lines can be spoken in the original voice
- [ ] Native macOS SpeechAnalyzer as an optional transcription backend
- [ ] More languages beyond English / German; local model import for air-gapped first runs
- [ ] Faster export (stream-copy for keyframe-aligned segments, WebCodecs rendering)
- [ ] Multi-clip projects (reorder scenes), captions burn-in
- [ ] Gap clips / insert silence between words
