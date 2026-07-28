"use client";

import { create } from "zustand";
import type { CutAdjustments, EditorStatus, ProgressInfo, Word } from "./types";
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

interface PendingTranscript {
  name: string;
  words: Word[];
}

/**
 * A unit of undoable editor state. Cut-edge adjustments are versioned
 * alongside word edits so a manual trim undoes/redoes like any other edit.
 */
interface Snapshot {
  words: Word[];
  cutAdjustments: CutAdjustments;
}

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
   * Caption file parsed on the upload screen when source is "import".
   * Cleared when switching back to a Whisper model or after media loads.
   */
  pendingTranscript: PendingTranscript | null;
  /** IndexedDB project id when this session is persisted; null for a fresh upload mid-pipeline. */
  projectId: string | null;
  /**
   * When true, Editor extracts audio for the waveform but skips Whisper
   * (restored projects / imported transcripts already have words).
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
  /** Manual cut-edge overrides, keyed by CutRange.key (see lib/edits.ts). */
  cutAdjustments: CutAdjustments;
  past: Snapshot[];
  future: Snapshot[];

  // Playback (mirrored from the <video>/<audio> element for UI rendering)
  currentTime: number;
  playing: boolean;
  videoEl: HTMLMediaElement | null;

  // Export
  exportUrl: string | null;
  exportOpen: boolean;

  // Actions
  /** Load media for editing. Pass `words` to skip Whisper and use that transcript. */
  loadVideo: (file: File, options?: { words?: Word[] }) => void;
  /** Restore a saved project from IndexedDB (no re-transcription). */
  openProject: (id: string) => Promise<void>;
  /** Delete a saved project; if it is the active one, resets to the home screen. */
  removeProject: (id: string) => Promise<void>;
  setModel: (m: ModelChoice) => void;
  setPendingTranscript: (t: PendingTranscript | null) => void;
  setDuration: (d: number) => void;
  setAudio: (a: Float32Array) => void;
  setStatus: (s: EditorStatus) => void;
  setProgress: (p: ProgressInfo) => void;
  setPartialText: (t: string) => void;
  setError: (message: string) => void;
  setWords: (words: Word[]) => void;
  /**
   * Replace the current transcript with an imported one (keeps media).
   * Used when the user brings their own SRT/VTT/JSON instead of Whisper.
   */
  importWords: (words: Word[]) => void;
  deleteWords: (ids: number[]) => void;
  restoreWords: (ids: number[]) => void;
  /** Replace the selected (contiguous) words with corrected text. */
  correctWords: (ids: number[], text: string) => void;
  /**
   * Set one edge of a cut's manual override (absolute time in original media
   * seconds). Pass `commit: true` on the first change of a drag to open a new
   * undo step; `false` for subsequent moves so the whole drag is one undo.
   */
  adjustCut: (key: number, edge: "start" | "end", time: number, commit: boolean) => void;
  /** Clear a cut's manual override, reverting it to the word-derived edges. */
  resetCutAdjust: (key: number) => void;
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

/** Capture the current undoable state (words + cut adjustments). */
function snapshotOf(s: { words: Word[]; cutAdjustments: CutAdjustments }): Snapshot {
  return { words: s.words, cutAdjustments: s.cutAdjustments };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  videoFile: null,
  mediaUrl: null,
  mediaKind: null,
  duration: 0,
  audio: null,
  model: "base",
  pendingTranscript: null,
  projectId: null,
  skipTranscription: false,

  status: "idle",
  progress: { message: "", value: null },
  partialText: "",
  error: null,

  words: [],
  showDeleted: true,
  cutAdjustments: {},
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
    if (imported && imported.length === 0) return;
    const prev = get().mediaUrl;
    if (prev) URL.revokeObjectURL(prev);
    const current = get().model;
    set({
      videoFile: file,
      mediaUrl: URL.createObjectURL(file),
      mediaKind: kind,
      projectId: null,
      skipTranscription: Boolean(imported),
      model: imported ? "import" : isWhisperModel(current) ? current : "base",
      pendingTranscript: null,
      status: "preparing",
      progress: {
        message: imported ? "Loading media…" : "Loading media engine…",
        value: null,
      },
      words: imported ? imported : [],
      cutAdjustments: {},
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
      status: "preparing",
      progress: { message: "Loading media engine…", value: null },
      words: record.words,
      showDeleted: record.showDeleted,
      cutAdjustments: record.cutAdjustments ?? {},
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
      set({ model, pendingTranscript: null });
    } else {
      set({ model });
    }
  },
  setPendingTranscript: (pendingTranscript) => set({ pendingTranscript }),
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
    set({ words, cutAdjustments: {}, past: [], future: [] });
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
      cutAdjustments: {},
      past: [],
      future: [],
      partialText: "",
      error: null,
      status: "ready",
      progress: { message: "", value: null },
      skipTranscription: true,
      model: "import",
    });
    bumpAutosave();
  },

  deleteWords: (ids) => {
    if (ids.length === 0) return;
    const { words, past } = get();
    const idSet = new Set(ids);
    set({
      past: [...past, snapshotOf(get())],
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
      past: [...past, snapshotOf(get())],
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
      past: [...past, snapshotOf(get())],
      future: [],
      words: [...words.slice(0, from), ...replacement, ...words.slice(to + 1)],
    });
    bumpAutosave();
  },
  adjustCut: (key, edge, time, commit) => {
    const { cutAdjustments, past } = get();
    const nextAdjustments: CutAdjustments = {
      ...cutAdjustments,
      [key]: { ...(cutAdjustments[key] ?? {}), [edge]: time },
    };
    set({
      cutAdjustments: nextAdjustments,
      // Open a new undo step only on the first change of a drag.
      ...(commit ? { past: [...past, snapshotOf(get())], future: [] } : {}),
    });
    bumpAutosave();
  },
  resetCutAdjust: (key) => {
    const { cutAdjustments, past } = get();
    if (!cutAdjustments[key]) return;
    const nextAdjustments = { ...cutAdjustments };
    delete nextAdjustments[key];
    set({
      past: [...past, snapshotOf(get())],
      future: [],
      cutAdjustments: nextAdjustments,
    });
    bumpAutosave();
  },
  undo: () => {
    const { past, future } = get();
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    set({
      words: prev.words,
      cutAdjustments: prev.cutAdjustments,
      past: past.slice(0, -1),
      future: [snapshotOf(get()), ...future],
    });
    bumpAutosave();
  },
  redo: () => {
    const { past, future } = get();
    if (future.length === 0) return;
    const next = future[0];
    set({
      words: next.words,
      cutAdjustments: next.cutAdjustments,
      past: [...past, snapshotOf(get())],
      future: future.slice(1),
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
      projectId: null,
      skipTranscription: false,
      status: "idle",
      progress: { message: "", value: null },
      partialText: "",
      error: null,
      words: [],
      cutAdjustments: {},
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
