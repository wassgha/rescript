"use client";

import { create } from "zustand";
import type {
  EditSnapshot,
  EditorStatus,
  ManualCut,
  ProgressInfo,
  SceneBoundary,
  Word,
} from "./types";
import {
  applyWordBounds,
  canSplitAt,
  carrySceneBoundaries,
  getClipSegments,
  getCutRanges,
  getKeepRanges,
  shrinkManualCuts,
  trimEdgeResult,
} from "./edits";
import {
  isModelChoice,
  isSpeechAnalyzerModel,
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
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
  showDeleted: boolean;
  past: EditSnapshot[];
  future: EditSnapshot[];
  /** Selected timeline clip index, or null. */
  selectedClipIndex: number | null;
  /**
   * Words selected in the transcript or the timeline wordbar. Shared so both
   * views highlight the same selection and the same shortcuts apply.
   */
  selectedWordIds: number[];
  nextManualCutId: number;
  nextBoundaryId: number;
  /**
   * When true, subsequent edit mutations coalesce into the undo entry
   * created by `beginGesture` (one undo step per drag).
   */
  gestureActive: boolean;

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
  /** Nudge a word's start/end on the timeline (may steal time from neighbors). */
  adjustWordBounds: (id: number, start: number, end: number) => void;
  /** Insert a scene boundary at the playhead. */
  splitAtPlayhead: () => boolean;
  /** Remove a scene boundary by id (join adjacent clips). */
  removeSceneBoundary: (id: number) => void;
  /**
   * Move one edge of a kept region from `from` to `to` (original-media times).
   * `edge` names the side that stays kept ("in" = the clip to the right of the
   * edge, "out" = the clip to the left), which is what decides whether the move
   * cuts or reclaims. Edges are addressed by time, not clip index, because a
   * trim can merge or split clips mid-drag and renumber them.
   */
  trimEdge: (edge: "in" | "out", from: number, to: number) => void;
  setSelectedClipIndex: (index: number | null) => void;
  setSelectedWords: (ids: number[]) => void;
  /** Start a drag gesture so subsequent edits share one undo entry. */
  beginGesture: () => void;
  /** End the current drag gesture. */
  endGesture: () => void;
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

function snapshotOf(s: {
  words: Word[];
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
}): EditSnapshot {
  return {
    words: s.words,
    manualCuts: s.manualCuts,
    sceneBoundaries: s.sceneBoundaries,
  };
}

function snapshotsEqual(a: EditSnapshot, b: EditSnapshot): boolean {
  return (
    a.words === b.words &&
    a.manualCuts === b.manualCuts &&
    a.sceneBoundaries === b.sceneBoundaries
  );
}

function maxId(items: Array<{ id: number }>, fallback = 1): number {
  return items.reduce((m, x) => Math.max(m, x.id), fallback - 1) + 1;
}

function pushEdit(
  get: () => EditorState,
  set: (
    partial:
      | Partial<EditorState>
      | ((s: EditorState) => Partial<EditorState>)
  ) => void,
  next: Partial<
    Pick<
      EditorState,
      | "words"
      | "manualCuts"
      | "sceneBoundaries"
      | "selectedClipIndex"
      | "selectedWordIds"
      | "nextManualCutId"
      | "nextBoundaryId"
    >
  >
) {
  const s = get();
  if (s.gestureActive) {
    // Coalesce into the snapshot already pushed by beginGesture.
    set({ future: [], ...next });
  } else {
    set({
      past: [...s.past, snapshotOf(s)],
      future: [],
      ...next,
    });
  }
  bumpAutosave();
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
  manualCuts: [],
  sceneBoundaries: [],
  showDeleted: true,
  past: [],
  future: [],
  selectedClipIndex: null,
  selectedWordIds: [],
  nextManualCutId: 1,
  nextBoundaryId: 1,
  gestureActive: false,

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
      model: imported
        ? "import"
        : isWhisperModel(current) || isSpeechAnalyzerModel(current)
          ? current
          : "base",
      pendingTranscript: null,
      status: "preparing",
      progress: {
        message: imported ? "Loading media…" : "Loading media engine…",
        value: null,
      },
      words: imported ? imported : [],
      manualCuts: [],
      sceneBoundaries: [],
          past: [],
      future: [],
      selectedClipIndex: null,
      selectedWordIds: [],
      nextManualCutId: 1,
      nextBoundaryId: 1,
      gestureActive: false,
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
    const manualCuts = record.manualCuts ?? [];
    const sceneBoundaries = record.sceneBoundaries ?? [];
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
      manualCuts,
      sceneBoundaries,
      showDeleted: record.showDeleted,
      past: [],
      future: [],
      selectedClipIndex: null,
      selectedWordIds: [],
      nextManualCutId: maxId(manualCuts, 1),
      nextBoundaryId: maxId(sceneBoundaries, 1),
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
    if (isWhisperModel(model) || isSpeechAnalyzerModel(model)) {
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
    set({
      words,
      manualCuts: [],
      sceneBoundaries: [],
          past: [],
      future: [],
      selectedClipIndex: null,
      selectedWordIds: [],
    });
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
      manualCuts: [],
      sceneBoundaries: [],
          past: [],
      future: [],
      selectedClipIndex: null,
      selectedWordIds: [],
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
    const { words } = get();
    const idSet = new Set(ids);
    pushEdit(get, set, {
      words: words.map((w) =>
        idSet.has(w.id) && !w.deleted ? { ...w, deleted: true } : w
      ),
    });
  },
  restoreWords: (ids) => {
    if (ids.length === 0) return;
    const s = get();
    const idSet = new Set(ids);
    const restored = s.words.filter((w) => idSet.has(w.id));
    if (restored.length === 0) return;

    // Pull manual cuts off the restored words so transcript restore also
    // brings the audio back (trim-created cuts would otherwise remain).
    let manualCuts = s.manualCuts;
    let nextManualCutId = s.nextManualCutId;
    for (const w of restored) {
      const shrunk = shrinkManualCuts(
        manualCuts,
        w.start,
        w.end,
        nextManualCutId
      );
      manualCuts = shrunk.cuts;
      nextManualCutId = shrunk.nextId;
    }

    const words = s.words.map((w) =>
      idSet.has(w.id) ? { ...w, deleted: false } : w
    );

    pushEdit(get, set, {
      words,
      manualCuts,
      nextManualCutId,
    });
  },
  correctWords: (ids, text) => {
    const { words } = get();
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

    pushEdit(get, set, {
      words: [...words.slice(0, from), ...replacement, ...words.slice(to + 1)],
      // The corrected span is new words with new ids; nothing to stay selected.
      selectedWordIds: [],
    });
  },

  adjustWordBounds: (id, start, end) => {
    const { words, duration } = get();
    const next = applyWordBounds(words, id, start, end, duration);
    if (!next) return;
    pushEdit(get, set, { words: next });
  },

  splitAtPlayhead: () => {
    const s = get();
    const t = s.currentTime;
    const cuts = getCutRanges(s.words, s.duration, s.manualCuts);
    if (!canSplitAt(t, s.duration, cuts, s.sceneBoundaries)) return false;
    const id = s.nextBoundaryId;
    pushEdit(get, set, {
      sceneBoundaries: [...s.sceneBoundaries, { id, time: t }].sort(
        (a, b) => a.time - b.time
      ),
      nextBoundaryId: id + 1,
    });
    return true;
  },

  removeSceneBoundary: (id) => {
    const { sceneBoundaries } = get();
    if (!sceneBoundaries.some((b) => b.id === id)) return;
    pushEdit(get, set, {
      sceneBoundaries: sceneBoundaries.filter((b) => b.id !== id),
      selectedClipIndex: null,
    });
  },

  trimEdge: (edge, from, to) => {
    const s = get();
    const result = trimEdgeResult(
      s.words,
      s.manualCuts,
      edge,
      from,
      to,
      s.nextManualCutId
    );
    if (!result) return;

    // A split point sitting on the dragged edge *is* that edge — it has to move
    // with it, or the span the drag reclaims becomes an orphan clip.
    const sceneBoundaries = carrySceneBoundaries(s.sceneBoundaries, from, to);

    // Clip indices shift whenever a trim merges or splits keep ranges, so
    // re-find the clip that owns the moved edge instead of keeping an index.
    const clips = getClipSegments(
      getKeepRanges(
        getCutRanges(result.words, s.duration, result.manualCuts),
        s.duration
      ),
      sceneBoundaries
    );
    const owner =
      clips.find((c) => Math.abs((edge === "in" ? c.start : c.end) - to) < 1e-3) ??
      clips.find((c) => to >= c.start && to <= c.end);

    pushEdit(get, set, {
      words: result.words,
      manualCuts: result.manualCuts,
      sceneBoundaries,
      nextManualCutId: result.nextCutId,
      selectedClipIndex: owner?.index ?? s.selectedClipIndex,
    });
  },

  setSelectedClipIndex: (selectedClipIndex) => set({ selectedClipIndex }),

  setSelectedWords: (selectedWordIds) => set({ selectedWordIds }),

  beginGesture: () => {
    const s = get();
    if (s.gestureActive) return;
    set({
      gestureActive: true,
      past: [...s.past, snapshotOf(s)],
      future: [],
    });
  },
  endGesture: () => {
    const s = get();
    if (!s.gestureActive) return;
    const last = s.past[s.past.length - 1];
    if (last && snapshotsEqual(last, snapshotOf(s))) {
      // No net change — drop the empty undo entry.
      set({ gestureActive: false, past: s.past.slice(0, -1) });
    } else {
      set({ gestureActive: false });
      bumpAutosave();
    }
  },

  undo: () => {
    const { past, future, words, manualCuts, sceneBoundaries } =
      get();
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    set({
      words: prev.words,
      manualCuts: prev.manualCuts,
      sceneBoundaries: prev.sceneBoundaries,
      past: past.slice(0, -1),
      future: [
        { words, manualCuts, sceneBoundaries },
        ...future,
      ],
      selectedClipIndex: null,
      selectedWordIds: [],
      gestureActive: false,
    });
    bumpAutosave();
  },
  redo: () => {
    const { past, future, words, manualCuts, sceneBoundaries } =
      get();
    if (future.length === 0) return;
    const next = future[0];
    set({
      words: next.words,
      manualCuts: next.manualCuts,
      sceneBoundaries: next.sceneBoundaries,
      future: future.slice(1),
      past: [...past, { words, manualCuts, sceneBoundaries }],
      selectedClipIndex: null,
      selectedWordIds: [],
      gestureActive: false,
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
      manualCuts: [],
      sceneBoundaries: [],
          past: [],
      future: [],
      selectedClipIndex: null,
      selectedWordIds: [],
      nextManualCutId: 1,
      nextBoundaryId: 1,
      gestureActive: false,
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
  // SpeechAnalyzer only works in the macOS Electron app — fall back on web.
  if (
    isSpeechAnalyzerModel(stored) &&
    (typeof window === "undefined" ||
      window.rescriptDesktop?.platform !== "darwin" ||
      !window.rescriptDesktop.speechAnalyzer)
  ) {
    if (useEditorStore.getState().model !== "base") {
      useEditorStore.setState({ model: "base" });
    }
    return;
  }
  if (stored !== useEditorStore.getState().model) {
    useEditorStore.setState({ model: stored });
  }
}

export type { ProjectMeta };
