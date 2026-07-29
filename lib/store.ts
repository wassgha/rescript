"use client";

import { create } from "zustand";
import type { EditorStatus, ProgressInfo, Word } from "./types";
import type { AlignToken } from "./alignTranscript";
import {
  isModelChoice,
  isWhisperModel,
  loadModelPreference,
  saveModelPreference,
} from "./models";
import type { ModelChoice } from "./models";
import { detectMediaKind, type MediaKind } from "./media";
import {
  deleteProject,
  fileFromProject,
  getProject,
  type ProjectMeta,
} from "./projects";

/** Caption file chosen on the upload screen (timed) or plain text to sync. */
export type PendingTranscript =
  | { name: string; kind: "timed"; words: Word[] }
  | { name: string; kind: "untimed"; tokens: AlignToken[] };

interface EditorState {
  // Media
  videoFile: File | null;
  mediaUrl: string | null;
  /** Whether the loaded file is video or audio-only. */
  mediaKind: MediaKind | null;
  duration: number;
  /** Mono 16 kHz PCM of the media's audio track (used for waveform + ASR). */
  audio: Float32Array | null;
  /** Transcript source selected on the upload screen (Whisper or import). */
  model: ModelChoice;
  /**
   * Caption / text file parsed on the upload screen when source is "import".
   * Cleared when switching back to a Whisper model or after media loads.
   */
  pendingTranscript: PendingTranscript | null;
  /**
   * Untimed tokens waiting to be aligned after Whisper finishes (Descript-style
   * sync). Set when loading media with a plain-text transcript.
   */
  syncTokens: AlignToken[] | null;
  /** IndexedDB project id when this session is persisted; null for a fresh upload mid-pipeline. */
  projectId: string | null;
  /**
   * When true, Editor extracts audio for the waveform but skips Whisper
   * (restored projects / timed imported transcripts already have words).
   */
  skipTranscription: boolean;

  // Pipeline status
  status: EditorStatus;
  progress: ProgressInfo;
  /** Streaming partial transcript text while transcribing. */
  partialText: string;
  error: string | null;

  // Transcript / edits
  words: Word[];
  showDeleted: boolean;
  past: Word[][];
  future: Word[][];

  // Playback (mirrored from the <video>/<audio> element for UI rendering)
  currentTime: number;
  playing: boolean;
  videoEl: HTMLMediaElement | null;

  // Export
  exportUrl: string | null;
  exportOpen: boolean;

  // Actions
  /**
   * Load media for editing.
   * - `words`: timed transcript → skip Whisper
   * - `syncTokens`: plain text → run Whisper then align
   */
  loadVideo: (
    file: File,
    options?: { words?: Word[]; syncTokens?: AlignToken[] }
  ) => void;
  /** Restore a saved project from IndexedDB (no re-transcription). */
  openProject: (id: string) => Promise<void>;
  /** Delete a saved project; if it is the active one, resets to the home screen. */
  removeProject: (id: string) => Promise<void>;
  setModel: (m: ModelChoice) => void;
  setPendingTranscript: (t: PendingTranscript | null) => void;
  setSyncTokens: (t: AlignToken[] | null) => void;
  setDuration: (d: number) => void;
  setAudio: (a: Float32Array) => void;
  setStatus: (s: EditorStatus) => void;
  setProgress: (p: ProgressInfo) => void;
  setPartialText: (t: string) => void;
  setError: (message: string) => void;
  setWords: (words: Word[]) => void;
  /**
   * Replace the current transcript with an imported one (keeps media).
   * Used for timed SRT/VTT/JSON, or after aligning plain text.
   */
  importWords: (words: Word[]) => void;
  deleteWords: (ids: number[]) => void;
  restoreWords: (ids: number[]) => void;
  /** Replace the selected (contiguous) words with corrected text. */
  correctWords: (ids: number[], text: string) => void;
  undo: () => void;
  redo: () => void;
  toggleShowDeleted: () => void;
  setCurrentTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setVideoEl: (el: HTMLMediaElement | null) => void;
  setExportUrl: (url: string | null) => void;
  setExportOpen: (open: boolean) => void;
  reset: () => void;
}

function bumpAutosave() {
  // Dynamic import avoids a circular dependency with lib/autosave.ts.
  void import("./autosave").then((m) => m.scheduleProjectAutosave());
}

export const useEditorStore = create<EditorState>((set, get) => ({
  videoFile: null,
  mediaUrl: null,
  mediaKind: null,
  duration: 0,
  audio: null,
  model: "base",
  pendingTranscript: null,
  syncTokens: null,
  projectId: null,
  skipTranscription: false,

  status: "idle",
  progress: { message: "", value: null },
  partialText: "",
  error: null,

  words: [],
  showDeleted: true,
  past: [],
  future: [],

  currentTime: 0,
  playing: false,
  videoEl: null,

  exportUrl: null,
  exportOpen: false,

  loadVideo: (file, options) => {
    const kind = detectMediaKind(file);
    if (!kind) return;
    const imported = options?.words;
    const syncTokens = options?.syncTokens ?? null;
    if (imported && imported.length === 0) return;
    if (syncTokens && syncTokens.length === 0) return;
    const prev = get().mediaUrl;
    if (prev) URL.revokeObjectURL(prev);
    const current = get().model;
    const timedImport = Boolean(imported);
    const syncImport = Boolean(syncTokens);
    set({
      videoFile: file,
      mediaUrl: URL.createObjectURL(file),
      mediaKind: kind,
      projectId: null,
      // Timed captions skip Whisper; plain text still needs ASR for timing.
      skipTranscription: timedImport,
      syncTokens: syncImport ? syncTokens : null,
      model:
        timedImport || syncImport
          ? "import"
          : isWhisperModel(current)
            ? current
            : "base",
      pendingTranscript: null,
      status: "preparing",
      progress: {
        message: timedImport
          ? "Loading media…"
          : syncImport
            ? "Loading media to sync transcript…"
            : "Loading media engine…",
        value: null,
      },
      words: imported ? imported : [],
      past: [],
      future: [],
      partialText: "",
      error: null,
      currentTime: 0,
      exportUrl: null,
      audio: null,
      duration: 0,
    });
  },

  openProject: async (id) => {
    const record = await getProject(id);
    if (!record) throw new Error("That project is no longer saved.");
    const file = fileFromProject(record);
    const prev = get().mediaUrl;
    if (prev) URL.revokeObjectURL(prev);
    set({
      videoFile: file,
      mediaUrl: URL.createObjectURL(file),
      mediaKind: record.mediaKind,
      duration: record.duration,
      model: isModelChoice(record.model) ? record.model : "base",
      projectId: record.id,
      skipTranscription: true,
      pendingTranscript: null,
      syncTokens: null,
      status: "preparing",
      progress: { message: "Loading media engine…", value: null },
      words: record.words,
      showDeleted: record.showDeleted,
      past: [],
      future: [],
      partialText: "",
      error: null,
      currentTime: 0,
      playing: false,
      exportUrl: null,
      exportOpen: false,
      audio: null,
    });
  },

  removeProject: async (id) => {
    await deleteProject(id);
    if (get().projectId === id) {
      get().reset();
    }
  },

  setModel: (model) => {
    if (isWhisperModel(model)) {
      saveModelPreference(model);
      set({ model, pendingTranscript: null, syncTokens: null });
    } else {
      set({ model });
    }
  },
  setPendingTranscript: (pendingTranscript) => set({ pendingTranscript }),
  setSyncTokens: (syncTokens) => set({ syncTokens }),
  setDuration: (duration) => {
    set({ duration });
    if (get().status === "ready") bumpAutosave();
  },
  setAudio: (audio) => set({ audio }),
  setStatus: (status) => {
    set({ status });
    if (status === "ready") bumpAutosave();
  },
  setProgress: (progress) => set({ progress }),
  setPartialText: (partialText) => set({ partialText }),
  setError: (message) => set({ status: "error", error: message }),
  setWords: (words) => {
    set({ words, past: [], future: [] });
    if (get().status === "ready") bumpAutosave();
  },
  importWords: (words) => {
    if (words.length === 0) return;
    const { status } = get();
    if (
      status !== "ready" &&
      status !== "error" &&
      status !== "transcribing"
    ) {
      return;
    }
    // Stop Whisper if it was still running.
    void import("@/hooks/useTranscriber").then((m) => m.cancelTranscription());
    set({
      words,
      past: [],
      future: [],
      partialText: "",
      error: null,
      status: "ready",
      progress: { message: "", value: null },
      skipTranscription: true,
      syncTokens: null,
      model: "import",
    });
    bumpAutosave();
  },

  deleteWords: (ids) => {
    if (ids.length === 0) return;
    const { words, past } = get();
    const idSet = new Set(ids);
    set({
      past: [...past, words],
      future: [],
      words: words.map((w) => (idSet.has(w.id) && !w.deleted ? { ...w, deleted: true } : w)),
    });
    bumpAutosave();
  },
  restoreWords: (ids) => {
    if (ids.length === 0) return;
    const { words, past } = get();
    const idSet = new Set(ids);
    set({
      past: [...past, words],
      future: [],
      words: words.map((w) => (idSet.has(w.id) && w.deleted ? { ...w, deleted: false } : w)),
    });
    bumpAutosave();
  },
  correctWords: (ids, text) => {
    const { words, past } = get();
    const tokens = text.split(/\s+/).filter(Boolean);
    if (ids.length === 0 || tokens.length === 0) return;
    const idSet = new Set(ids);
    const indices = words.reduce<number[]>((acc, w, i) => {
      if (idSet.has(w.id)) acc.push(i);
      return acc;
    }, []);
    if (indices.length === 0) return;
    // Replace the whole contiguous slice covered by the selection.
    const from = indices[0];
    const to = indices[indices.length - 1];
    const selected = words.slice(from, to + 1);
    if (selected.map((w) => w.text).join(" ") === tokens.join(" ")) return;

    // Distribute the original time span across the new words in proportion
    // to their character length.
    const spanStart = selected[0].start;
    const spanEnd = selected[selected.length - 1].end;
    const span = Math.max(0.02, spanEnd - spanStart);
    const totalChars = tokens.reduce((acc, t) => acc + t.length, 0);
    let nextId = words.reduce((m, w) => Math.max(m, w.id), 0) + 1;
    let cursor = spanStart;
    const replacement: Word[] = tokens.map((t) => {
      const dur = (span * t.length) / totalChars;
      const word: Word = {
        id: nextId++,
        text: t,
        start: cursor,
        end: Math.min(spanEnd, cursor + dur),
        speaker: selected[0].speaker,
        // A correction implies the words are wanted, unless the whole
        // selection was already cut.
        deleted: selected.every((w) => w.deleted),
      };
      cursor = word.end;
      return word;
    });
    replacement[replacement.length - 1].end = spanEnd;

    set({
      past: [...past, words],
      future: [],
      words: [...words.slice(0, from), ...replacement, ...words.slice(to + 1)],
    });
    bumpAutosave();
  },
  undo: () => {
    const { past, future, words } = get();
    if (past.length === 0) return;
    set({
      words: past[past.length - 1],
      past: past.slice(0, -1),
      future: [words, ...future],
    });
    bumpAutosave();
  },
  redo: () => {
    const { past, future, words } = get();
    if (future.length === 0) return;
    set({
      words: future[0],
      future: future.slice(1),
      past: [...past, words],
    });
    bumpAutosave();
  },
  toggleShowDeleted: () => {
    set((s) => ({ showDeleted: !s.showDeleted }));
    bumpAutosave();
  },

  setCurrentTime: (currentTime) => set({ currentTime }),
  setPlaying: (playing) => set({ playing }),
  setVideoEl: (videoEl) => set({ videoEl }),
  setExportUrl: (exportUrl) => set({ exportUrl }),
  setExportOpen: (exportOpen) => set({ exportOpen }),

  reset: () => {
    const { mediaUrl, exportUrl } = get();
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    set({
      videoFile: null,
      mediaUrl: null,
      mediaKind: null,
      duration: 0,
      audio: null,
      model: loadModelPreference(),
      pendingTranscript: null,
      syncTokens: null,
      projectId: null,
      skipTranscription: false,
      status: "idle",
      progress: { message: "", value: null },
      partialText: "",
      error: null,
      words: [],
      past: [],
      future: [],
      currentTime: 0,
      playing: false,
      exportUrl: null,
      exportOpen: false,
    });
  },
}));

/** Apply the stored model choice after mount (avoids SSR/localStorage mismatch). */
export function hydrateModelPreference() {
  const stored = loadModelPreference();
  if (stored !== useEditorStore.getState().model) {
    useEditorStore.setState({ model: stored });
  }
}

export type { ProjectMeta };
