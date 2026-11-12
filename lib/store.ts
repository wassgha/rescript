"use client";

import { create } from "zustand";
import type {
  EditSnapshot,
  EditorStatus,
  ManualCut,
  ProgressInfo,
  SceneBoundary,
  SourceCopy,
  SpeakerInfo,
  TimeRange,
  Word,
} from "./types";
import {
  addManualCut,
  applyWordBounds,
  canSplitAt,
  carrySceneBoundaries,
  deleteWordsCoveredBy,
  getClipSegments,
  PLAYHEAD_EPSILON_S,
  restoreRangesResult,
  shrinkManualCuts,
  SPLIT_EPSILON,
  trimEdgeResult,
} from "./edits";
import {
  activeWordId,
  copyOf,
  cutsOf,
  displayTimeInRun,
  editedTimeInRun,
  playheadPiece,
  playheadRun,
  ofCopy,
  pasteClipboard,
  pieceAtOrAfter,
  sequenceFor,
  snapshotSelection,
  withSourceRanks,
  wordsOfCopy,
  type Clipboard,
  type Sequence,
} from "./sequence";
import { isModelId, loadModelPreference, saveModelPreference } from "./models";
import { isTranscriptSource, type TranscriptSource } from "./source";
import { trackEvent } from "./telemetry";
import {
  DEFAULT_TRANSCRIPT_LANGUAGE,
  isTranscriptLanguage,
  loadTranscriptLanguagePreference,
  saveTranscriptLanguagePreference,
  type TranscriptLanguage,
} from "./languages";
import { en } from "@/lib/i18n/messages/en";
import { detectMediaKind, type MediaKind } from "./media";
import { buildWaveformPeaks, type WaveformPeaks } from "./waveform";
import {
  deleteProject,
  fileFromProject,
  getProject,
} from "./projects";
import {
  cancelNativeJobs,
  discardNativeExport,
  releaseNativeMedia,
  setSourceHint,
} from "./nativeMedia";
import {
  addSpeaker as addSpeakerEntry,
  findSpeakerByName,
  moveSpeakerBoundary,
  reassignWords,
  removeSpeaker as removeSpeakerEntry,
  renameSpeaker as renameSpeakerEntry,
  replaceSpeaker as replaceSpeakerEntry,
  speakersFromWords,
} from "./speakers";

/**
 * A finished media export. The web build holds it as a Blob URL; the desktop
 * app's native engine leaves it as a file in the main process's temp dir until
 * the user saves it (`savedName` once they have).
 */
export type ExportResult =
  | { kind: "blob"; url: string }
  | { kind: "file"; outputId: string; size: number; savedName?: string };

/** Whether two results refer to the same underlying URL / rendered file. */
function sameExportResource(a: ExportResult, b: ExportResult): boolean {
  if (a.kind === "blob") return b.kind === "blob" && a.url === b.url;
  return b.kind === "file" && a.outputId === b.outputId;
}

/** Free whatever an export result holds onto. */
function disposeExportResult(result: ExportResult | null): void {
  if (!result) return;
  if (result.kind === "blob") URL.revokeObjectURL(result.url);
  else discardNativeExport(result.outputId);
}

/**
 * Leaving a file behind: stop its native jobs, drop its render and hand back
 * its registration (deleting the staged copy, if one was made).
 */
function releaseMediaResources(file: File | null, result: ExportResult | null): void {
  cancelNativeJobs();
  disposeExportResult(result);
  releaseNativeMedia(file);
}

interface PendingTranscript {
  name: string;
  words: Word[];
  speakers?: SpeakerInfo[];
  copies?: SourceCopy[];
}

interface EditorState {
  // Media
  videoFile: File | null;
  mediaUrl: string | null;
  /** Whether the loaded file is video or audio-only. */
  mediaKind: MediaKind | null;
  duration: number;
  /**
   * Min/max envelope of the media's audio track, for the timeline waveform.
   *
   * The decoded PCM itself is deliberately not kept: it is hundreds of
   * megabytes on a long recording and the worker takes ownership of it (see
   * useTranscriber). Null when the file has no audio track.
   */
  waveform: WaveformPeaks | null;
  /** Whether the media has an audio track at all. */
  hasAudio: boolean;
  /** Transcript source selected on the upload screen (speech model or import). */
  source: TranscriptSource;
  /** Language hint sent to Whisper when transcribing (Parakeet auto-detects). */
  transcriptLanguage: TranscriptLanguage;
  /**
   * Caption file parsed on the upload screen when source is "import".
   * Cleared when switching back to a speech model or after media loads.
   */
  pendingTranscript: PendingTranscript | null;
  /** IndexedDB project id when this session is persisted; null for a fresh upload mid-pipeline. */
  projectId: string | null;
  /**
   * When true, Editor extracts audio for the waveform but skips ASR
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
  /** Named speakers in the project (ids match Word.speaker). */
  speakers: SpeakerInfo[];
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
  /** Pasted duplicates of the media; words, cuts and splits refer to them by id. */
  copies: SourceCopy[];
  /** Words cut or copied from the transcript, ready to paste. */
  clipboard: Clipboard | null;
  showDeleted: boolean;
  past: EditSnapshot[];
  future: EditSnapshot[];
  /** Selected timeline clip index (into the clips of the playback sequence), or null. */
  selectedClipIndex: number | null;
  /**
   * Selected cut index (into the sequence's `displayCuts`), or null.
   * Used to restore a deleted clip / silence section from the timeline.
   */
  selectedCutIndex: number | null;
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
  /**
   * Copy the playhead is in. The same source time can play more than once;
   * (currentCopy, currentTime) names exactly one moment of the edit.
   */
  currentCopy: number;
  /**
   * Index of the sequence piece playback is in, as last reported by the
   * player; null after a seek. Disambiguates a run edge (see playheadPiece).
   */
  currentPiece: number | null;
  playing: boolean;
  videoEl: HTMLMediaElement | null;

  // Export
  exportResult: ExportResult | null;
  exportOpen: boolean;

  // Actions
  /** Load media for editing. Pass `words` to skip Whisper and use that transcript. */
  loadVideo: (
    file: File,
    options?: { words?: Word[]; speakers?: SpeakerInfo[]; copies?: SourceCopy[] }
  ) => void;
  /** Restore a saved project from IndexedDB (no re-transcription). */
  openProject: (id: string) => Promise<void>;
  /** Delete a saved project; if it is the active one, resets to the home screen. */
  removeProject: (id: string) => Promise<void>;
  setSource: (s: TranscriptSource) => void;
  setTranscriptLanguage: (language: TranscriptLanguage) => void;
  setPendingTranscript: (t: PendingTranscript | null) => void;
  setDuration: (d: number) => void;
  /**
   * Hand the decoded PCM to the store. Only the waveform envelope is retained;
   * the caller keeps ownership of the buffer itself (and transfers it to the
   * transcription worker).
   */
  setAudio: (a: Float32Array | null) => void;
  setStatus: (s: EditorStatus) => void;
  setProgress: (p: ProgressInfo) => void;
  setPartialText: (t: string) => void;
  setError: (message: string) => void;
  setWords: (words: Word[], speakers?: SpeakerInfo[]) => void;
  /**
   * Replace the current transcript with an imported one (keeps media).
   * Used when the user brings their own SRT/VTT/JSON instead of Whisper.
   */
  importWords: (words: Word[], speakers?: SpeakerInfo[], copies?: SourceCopy[]) => void;
  /** Rename a speaker everywhere it appears. */
  renameSpeaker: (id: number, name: string) => void;
  /** Create a new speaker; returns its id (or -1 if unchanged). */
  addSpeaker: (name?: string) => number;
  /** Reassign selected / listed words to a speaker (creating the speaker if needed). */
  reassignWordsToSpeaker: (ids: number[], toSpeaker: number) => void;
  /**
   * Change who speaks a turn. Pass `toSpeaker: "new"` to create a speaker.
   * Optional `name` renames/creates with that label.
   */
  changeTurnSpeaker: (
    wordIds: number[],
    toSpeaker: number | "new",
    name?: string
  ) => void;
  /** Move a turn's start to `targetWordId` (boundary with the previous turn). */
  moveSpeakerLabel: (turnStartWordId: number, targetWordId: number) => void;
  /** Merge all of `fromId` into `toId` across the project. */
  replaceSpeakerInProject: (fromId: number, toId: number) => void;
  /** Remove a speaker; their turns join the speaker above in the script. */
  removeSpeakerFromProject: (id: number) => void;
  deleteWords: (ids: number[]) => void;
  restoreWords: (ids: number[]) => void;
  /** Cut arbitrary time ranges (e.g. detected silences) as manual cuts. */
  cutRanges: (ranges: Array<TimeRange & { copy?: number }>) => void;
  /** Restore arbitrary cut ranges (manual cuts + covered deleted words). */
  restoreRanges: (ranges: Array<TimeRange & { copy?: number }>) => void;
  /** Cut the currently selected timeline clip out of the edited media. */
  deleteSelectedClip: () => boolean;
  /** Restore the currently selected cut range (deleted clip / silence). */
  restoreSelectedCut: () => boolean;
  /** Replace the selected (contiguous) words with corrected text. */
  correctWords: (ids: number[], text: string) => void;
  /** Nudge a word's start/end on the timeline (may steal time from neighbors). */
  adjustWordBounds: (id: number, start: number, end: number) => void;
  /** Insert a scene boundary at the playhead. */
  splitAtPlayhead: () => boolean;
  /** Remove a scene boundary by id (join adjacent clips). */
  removeSceneBoundary: (id: number) => void;
  /** Put words on the clipboard. Returns the plain text copied. */
  copyWords: (ids: number[]) => string | null;
  /** Put words on the clipboard and cut them; pasting moves them. Returns the text. */
  cutWords: (ids: number[]) => string | null;
  /**
   * Paste the clipboard before array index `at` (words.length = at the end):
   * moves the words of a fresh cut, otherwise inserts a duplicate.
   */
  pasteWords: (at: number) => boolean;
  /**
   * Move one edge of a kept region from `from` to `to` (original-media times).
   * `edge` names the side that stays kept ("in" = the clip to the right of the
   * edge, "out" = the clip to the left), which is what decides whether the move
   * cuts or reclaims. Edges are addressed by time, not clip index, because a
   * trim can merge or split clips mid-drag and renumber them.
   */
  trimEdge: (edge: "in" | "out", from: number, to: number, copy: number) => void;
  setSelectedClipIndex: (index: number | null) => void;
  setSelectedCutIndex: (index: number | null) => void;
  setSelectedWords: (ids: number[]) => void;
  /** Start a drag gesture so subsequent edits share one undo entry. */
  beginGesture: () => void;
  /** End the current drag gesture. */
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  toggleShowDeleted: () => void;
  /** Mirror the player's position (the piece it is in, when known). */
  setCurrentTime: (t: number, copy?: number, piece?: number | null) => void;
  /** Move the playhead to source time `t` (of `copy`, default: the current one). */
  seekTo: (t: number, copy?: number) => void;
  setPlaying: (p: boolean) => void;
  setVideoEl: (el: HTMLMediaElement | null) => void;
  /** Play/pause, skipping out of cut ranges and restarting from the start if parked at the end. */
  togglePlayback: () => void;
  /** Replace the current export result, freeing the previous one. */
  setExportResult: (result: ExportResult | null) => void;
  setExportOpen: (open: boolean) => void;
  reset: () => void;
}

function bumpAutosave() {
  // Dynamic import avoids a circular dependency with lib/autosave.ts.
  void import("./autosave").then((m) => m.scheduleProjectAutosave());
}

/**
 * How many undo steps to keep.
 *
 * Snapshots share structure with the live state, but every edit replaces the
 * words array wholesale, so each entry pins a distinct copy — on an hour-long
 * transcript that is a few megabytes per step. Unbounded, a long editing
 * session grows without limit and never gives any of it back. A hundred steps
 * is far more than anyone walks back through interactively.
 */
const MAX_UNDO_STEPS = 100;

/** Append to the undo stack, dropping the oldest entries past the cap. */
function pushHistory(past: EditSnapshot[], entry: EditSnapshot): EditSnapshot[] {
  const next = [...past, entry];
  return next.length > MAX_UNDO_STEPS ? next.slice(next.length - MAX_UNDO_STEPS) : next;
}

function snapshotOf(s: EditSnapshot): EditSnapshot {
  return {
    words: s.words,
    speakers: s.speakers,
    manualCuts: s.manualCuts,
    sceneBoundaries: s.sceneBoundaries,
    copies: s.copies,
  };
}

function snapshotsEqual(a: EditSnapshot, b: EditSnapshot): boolean {
  return (
    a.words === b.words &&
    a.speakers === b.speakers &&
    a.manualCuts === b.manualCuts &&
    a.sceneBoundaries === b.sceneBoundaries &&
    a.copies === b.copies
  );
}

function seqOf(s: {
  words: Word[];
  manualCuts: ManualCut[];
  copies: SourceCopy[];
  duration: number;
}): Sequence {
  return sequenceFor(s.words, s.manualCuts, s.copies, s.duration);
}

/** Mark items as belonging to `copy`; the original's items carry no copy field. */
function tagCopy<T extends { copy?: number }>(items: T[], copy: number): T[] {
  return items.map((x) => {
    if (copy !== 0) return x.copy === copy ? x : { ...x, copy };
    if (x.copy === undefined) return x;
    const rest = { ...x };
    delete rest.copy;
    return rest;
  });
}

/** Replace one copy's items (cuts, splits) with `next`, leaving other copies alone. */
function replaceCopyItems<T extends { copy?: number }>(
  all: T[],
  copy: number,
  next: T[]
): T[] {
  const others = all.filter((x) => copyOf(x) !== copy);
  return others.length === 0 ? tagCopy(next, copy) : [...others, ...tagCopy(next, copy)];
}

/**
 * Apply a source-time word edit to one copy only. `edit` sees that copy's words
 * in source order and may change their fields but not their ids.
 */
function editCopyWords(
  words: Word[],
  copy: number,
  edit: (copyWords: Word[]) => Word[]
): Word[] {
  const sub = wordsOfCopy(words, copy);
  const next = edit(sub);
  if (next === sub) return words;
  const byId = new Map(next.map((w) => [w.id, w]));
  return words.map((w) => (copyOf(w) === copy ? (byId.get(w.id) ?? w) : w));
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
      | "speakers"
      | "manualCuts"
      | "sceneBoundaries"
      | "copies"
      | "clipboard"
      | "selectedClipIndex"
      | "selectedCutIndex"
      | "selectedWordIds"
      | "nextManualCutId"
      | "nextBoundaryId"
    >
  >
) {
  const s = get();
  // Piece indices belong to the sequence before the edit.
  if (s.gestureActive) {
    // Coalesce into the snapshot already pushed by beginGesture.
    set({ future: [], currentPiece: null, ...next });
  } else {
    set({
      past: pushHistory(s.past, snapshotOf(s)),
      future: [],
      currentPiece: null,
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
  waveform: null,
  hasAudio: false,
  source: "base",
  transcriptLanguage: DEFAULT_TRANSCRIPT_LANGUAGE,
  pendingTranscript: null,
  projectId: null,
  skipTranscription: false,

  status: "idle",
  progress: { message: "", value: null },
  partialText: "",
  error: null,

  words: [],
  speakers: [],
  manualCuts: [],
  sceneBoundaries: [],
  copies: [],
  clipboard: null,
  showDeleted: true,
  past: [],
  future: [],
  selectedClipIndex: null,
  selectedCutIndex: null,
  selectedWordIds: [],
  nextManualCutId: 1,
  nextBoundaryId: 1,
  gestureActive: false,

  currentTime: 0,
  currentCopy: 0,
  currentPiece: null,
  playing: false,
  videoEl: null,

  exportResult: null,
  exportOpen: false,

  loadVideo: (file, options) => {
    const kind = detectMediaKind(file);
    if (!kind) return;
    const imported = options?.words;
    if (imported && imported.length === 0) return;
    const prev = get().mediaUrl;
    if (prev) URL.revokeObjectURL(prev);
    const prevFile = get().videoFile;
    releaseMediaResources(prevFile === file ? null : prevFile, get().exportResult);
    const current = get().source;
    const speakers = imported
      ? speakersFromWords(imported, options?.speakers ?? [])
      : [];
    set({
      videoFile: file,
      mediaUrl: URL.createObjectURL(file),
      mediaKind: kind,
      projectId: null,
      skipTranscription: Boolean(imported),
      source: imported ? "import" : isModelId(current) ? current : "base",
      pendingTranscript: null,
      status: "preparing",
      progress: {
        message: imported
          ? en["progress.loadingMedia"]
          : en["progress.loadingMediaEngine"],
        value: null,
      },
      words: imported ? imported : [],
      speakers,
      manualCuts: [],
      sceneBoundaries: [],
      copies: imported ? (options?.copies ?? []) : [],
      clipboard: null,
      past: [],
      future: [],
      selectedClipIndex: null,
      selectedCutIndex: null,
      selectedWordIds: [],
      nextManualCutId: 1,
      nextBoundaryId: 1,
      gestureActive: false,
      partialText: "",
      error: null,
      currentTime: 0,
      currentCopy: 0,
      currentPiece: null,
      exportResult: null,
      waveform: null,
      hasAudio: false,
      duration: 0,
    });
    // Funnel step between opening the app and getting a transcript. `kind` and
    // `source` are fixed vocabulary — nothing derived from the file itself.
    trackEvent("project_created", {
      kind,
      source: imported ? "import" : "asr",
    });
  },

  openProject: async (id) => {
    const record = await getProject(id);
    if (!record) throw new Error(en["error.projectMissing"]);
    const file = fileFromProject(record);
    // The bytes come back from IndexedDB, but the desktop engine would rather
    // read the original off disk than copy them out again — if it's unchanged.
    if (record.sourcePath && record.sourceSize === record.media.size) {
      setSourceHint(file, {
        path: record.sourcePath,
        size: record.sourceSize,
        mtime: record.sourceMtime ?? 0,
      });
    }
    const prev = get().mediaUrl;
    if (prev) URL.revokeObjectURL(prev);
    releaseMediaResources(get().videoFile, get().exportResult);
    const manualCuts = record.manualCuts ?? [];
    const sceneBoundaries = record.sceneBoundaries ?? [];
    const speakers = speakersFromWords(record.words, record.speakers ?? []);
    set({
      videoFile: file,
      mediaUrl: URL.createObjectURL(file),
      mediaKind: record.mediaKind,
      duration: record.duration,
      source: isTranscriptSource(record.source) ? record.source : "base",
      transcriptLanguage: isTranscriptLanguage(record.transcriptLanguage)
        ? record.transcriptLanguage
        : DEFAULT_TRANSCRIPT_LANGUAGE,
      projectId: record.id,
      skipTranscription: true,
      pendingTranscript: null,
      status: "preparing",
      progress: { message: en["progress.loadingMediaEngine"], value: null },
      words: record.words,
      speakers,
      manualCuts,
      sceneBoundaries,
      copies: record.copies ?? [],
      clipboard: null,
      showDeleted: record.showDeleted,
      past: [],
      future: [],
      selectedClipIndex: null,
      selectedCutIndex: null,
      selectedWordIds: [],
      nextManualCutId: maxId(manualCuts, 1),
      nextBoundaryId: maxId(sceneBoundaries, 1),
      partialText: "",
      error: null,
      currentTime: 0,
      currentCopy: 0,
      currentPiece: null,
      playing: false,
      exportResult: null,
      exportOpen: false,
      waveform: null,
      hasAudio: false,
    });
  },

  removeProject: async (id) => {
    await deleteProject(id);
    if (get().projectId === id) {
      get().reset();
    }
  },

  setSource: (source) => {
    if (isModelId(source)) {
      saveModelPreference(source);
      set({ source, pendingTranscript: null });
    } else {
      set({ source });
    }
  },
  setTranscriptLanguage: (transcriptLanguage) => {
    saveTranscriptLanguagePreference(transcriptLanguage);
    set({ transcriptLanguage });
  },
  setPendingTranscript: (pendingTranscript) => set({ pendingTranscript }),
  setDuration: (duration) => {
    set({ duration });
    if (get().status === "ready") bumpAutosave();
  },
  setAudio: (audio) =>
    set({
      waveform: audio && audio.length > 0 ? buildWaveformPeaks(audio) : null,
      hasAudio: audio !== null,
    }),
  setStatus: (status) => {
    set({ status });
    if (status === "ready") bumpAutosave();
  },
  setProgress: (progress) => set({ progress }),
  setPartialText: (partialText) => set({ partialText }),
  setError: (message) => set({ status: "error", error: message }),
  setWords: (words, speakers) => {
    set({
      words,
      speakers: speakersFromWords(words, speakers ?? []),
      manualCuts: [],
      sceneBoundaries: [],
      copies: [],
      currentPiece: null,
      clipboard: null,
      past: [],
      future: [],
      selectedClipIndex: null,
      selectedCutIndex: null,
      selectedWordIds: [],
    });
    if (get().status === "ready") bumpAutosave();
  },
  importWords: (words, speakers, copies) => {
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
      speakers: speakersFromWords(words, speakers ?? []),
      manualCuts: [],
      sceneBoundaries: [],
      copies: copies ?? [],
      currentPiece: null,
      clipboard: null,
      past: [],
      future: [],
      selectedClipIndex: null,
      selectedCutIndex: null,
      selectedWordIds: [],
      partialText: "",
      error: null,
      status: "ready",
      progress: { message: "", value: null },
      skipTranscription: true,
      source: "import",
    });
    bumpAutosave();
  },

  renameSpeaker: (id, name) => {
    const { speakers, words } = get();
    const next = renameSpeakerEntry(speakers, id, name);
    if (next === speakers) return;
    pushEdit(get, set, {
      speakers: speakersFromWords(words, next),
    });
  },

  addSpeaker: (name) => {
    const { speakers } = get();
    const trimmed = name?.trim();
    if (trimmed) {
      const existing = findSpeakerByName(speakers, trimmed);
      if (existing) return existing.id;
    }
    const { speakers: next, id } = addSpeakerEntry(speakers, name);
    pushEdit(get, set, { speakers: next });
    return id;
  },

  reassignWordsToSpeaker: (ids, toSpeaker) => {
    if (ids.length === 0) return;
    const s = get();
    const words = reassignWords(s.words, ids, toSpeaker);
    if (words === s.words) return;
    const speakers = speakersFromWords(words, s.speakers);
    pushEdit(get, set, { words, speakers });
  },

  changeTurnSpeaker: (wordIds, toSpeaker, name) => {
    if (wordIds.length === 0) return;
    const s = get();
    let speakers = s.speakers;
    let targetId: number;
    if (toSpeaker === "new") {
      const added = addSpeakerEntry(speakers, name);
      speakers = added.speakers;
      targetId = added.id;
    } else {
      targetId = toSpeaker;
      if (name && name.trim()) {
        speakers = renameSpeakerEntry(speakers, targetId, name);
      } else if (!speakers.some((sp) => sp.id === targetId)) {
        speakers = speakersFromWords(
          s.words,
          [...speakers, { id: targetId, name: `Speaker ${targetId + 1}` }]
        );
      }
    }
    const words = reassignWords(s.words, wordIds, targetId);
    if (words === s.words && speakers === s.speakers) return;
    pushEdit(get, set, {
      words,
      speakers: speakersFromWords(words, speakers),
    });
  },

  moveSpeakerLabel: (turnStartWordId, targetWordId) => {
    const { words } = get();
    const next = moveSpeakerBoundary(words, turnStartWordId, targetWordId);
    if (!next) return;
    pushEdit(get, set, { words: next });
  },

  replaceSpeakerInProject: (fromId, toId) => {
    const s = get();
    const result = replaceSpeakerEntry(s.words, s.speakers, fromId, toId);
    if (!result) return;
    pushEdit(get, set, {
      words: result.words,
      speakers: speakersFromWords(result.words, result.speakers),
    });
  },

  removeSpeakerFromProject: (id) => {
    const s = get();
    const result = removeSpeakerEntry(s.words, s.speakers, id);
    if (!result) return;
    pushEdit(get, set, {
      words: result.words,
      speakers: speakersFromWords(result.words, result.speakers),
    });
  },

  deleteWords: (ids) => {
    if (ids.length === 0) return;
    const { words } = get();
    const idSet = new Set(ids);
    pushEdit(get, set, {
      words: words.map((w) =>
        idSet.has(w.id) && !w.deleted ? { ...w, deleted: true } : w
      ),
      selectedCutIndex: null,
    });
  },
  cutRanges: (ranges) => {
    const usable = ranges.filter((r) => r.end - r.start > 1e-4);
    if (usable.length === 0) return;
    const s = get();
    let words = s.words;
    let manualCuts = s.manualCuts;
    let nextManualCutId = s.nextManualCutId;
    for (const r of usable) {
      const copy = r.copy ?? 0;
      const added = addManualCut(ofCopy(manualCuts, copy), r.start, r.end, nextManualCutId);
      manualCuts = replaceCopyItems(manualCuts, copy, added.cuts);
      nextManualCutId = added.nextId;
      words = editCopyWords(words, copy, (sub) => deleteWordsCoveredBy(sub, r.start, r.end));
    }
    pushEdit(get, set, {
      words,
      manualCuts,
      nextManualCutId,
      selectedClipIndex: null,
      selectedCutIndex: null,
      selectedWordIds: [],
    });
  },
  restoreRanges: (ranges) => {
    const s = get();
    let words = s.words;
    let manualCuts = s.manualCuts;
    let nextCutId = s.nextManualCutId;
    let changed = false;
    for (const copy of new Set(ranges.map((r) => r.copy ?? 0))) {
      const result = restoreRangesResult(
        wordsOfCopy(words, copy),
        ofCopy(manualCuts, copy),
        ranges.filter((r) => (r.copy ?? 0) === copy),
        nextCutId
      );
      if (!result) continue;
      changed = true;
      words = editCopyWords(words, copy, () => result.words);
      manualCuts = replaceCopyItems(manualCuts, copy, result.manualCuts);
      nextCutId = result.nextCutId;
    }
    if (!changed) return;
    pushEdit(get, set, {
      words,
      manualCuts,
      nextManualCutId: nextCutId,
      selectedClipIndex: null,
      selectedCutIndex: null,
      selectedWordIds: [],
    });
  },
  deleteSelectedClip: () => {
    const s = get();
    if (s.selectedClipIndex == null || s.duration <= 0) return false;
    const clips = getClipSegments(seqOf(s).pieces, s.sceneBoundaries);
    const clip = clips.find((c) => c.index === s.selectedClipIndex);
    if (!clip || clip.end - clip.start <= 1e-4) return false;
    get().cutRanges([{ start: clip.start, end: clip.end, copy: clip.copy }]);
    return true;
  },
  restoreSelectedCut: () => {
    const s = get();
    if (s.selectedCutIndex == null || s.duration <= 0) return false;
    const cut = seqOf(s).displayCuts[s.selectedCutIndex];
    if (!cut || cut.end - cut.start <= 1e-4) return false;
    get().restoreRanges([{ start: cut.start, end: cut.end, copy: cut.copy }]);
    return true;
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
      const copy = copyOf(w);
      const shrunk = shrinkManualCuts(
        ofCopy(manualCuts, copy),
        w.start,
        w.end,
        nextManualCutId
      );
      manualCuts = replaceCopyItems(manualCuts, copy, shrunk.cuts);
      nextManualCutId = shrunk.nextId;
    }

    const words = s.words.map((w) =>
      idSet.has(w.id) ? { ...w, deleted: false } : w
    );

    pushEdit(get, set, {
      words,
      manualCuts,
      nextManualCutId,
      selectedCutIndex: null,
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
    // Replace the whole contiguous slice covered by the selection — which has
    // to be one continuous stretch of media, not words from either side of a
    // reorder or from different copies.
    const from = indices[0];
    const to = indices[indices.length - 1];
    const seq = seqOf(get());
    if (seq.runOf[from] !== seq.runOf[to]) return;
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
    const { copy, src } = selected[0];
    const replacement: Word[] = tokens.map((t, k) => {
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
        ...(copy !== undefined ? { copy } : {}),
        // Fractional ranks slot in where the replaced words were; withSourceRanks
        // makes them whole again.
        ...(src !== undefined ? { src: src + k / tokens.length } : {}),
      };
      cursor = word.end;
      return word;
    });
    replacement[replacement.length - 1].end = spanEnd;
    const spliced = [...words.slice(0, from), ...replacement, ...words.slice(to + 1)];

    pushEdit(get, set, {
      words: src !== undefined ? withSourceRanks(spliced) : spliced,
      // The corrected span is new words with new ids; nothing to stay selected.
      selectedWordIds: [],
    });
  },

  adjustWordBounds: (id, start, end) => {
    const s = get();
    const { words } = s;
    const index = words.findIndex((w) => w.id === id);
    if (index < 0) return;
    // A word can only grow within the stretch of media it plays in: across a
    // reorder its source neighbour plays somewhere else entirely.
    const seq = seqOf(s);
    const run = seq.runs[seq.runOf[index]];
    const clamp = (t: number) => Math.min(run.end, Math.max(run.start, t));
    const slice = words.slice(run.from, run.to);
    const next = applyWordBounds(slice, id, clamp(start), clamp(end), run.end);
    if (!next) return;
    pushEdit(get, set, {
      words:
        run.from === 0 && run.to === words.length
          ? next
          : [...words.slice(0, run.from), ...next, ...words.slice(run.to)],
    });
  },

  splitAtPlayhead: () => {
    const s = get();
    if (!canSplitAtPlayhead(s)) return false;
    const t = s.currentTime;
    const copy = s.currentCopy;
    const id = s.nextBoundaryId;
    pushEdit(get, set, {
      sceneBoundaries: [
        ...s.sceneBoundaries,
        copy === 0 ? { id, time: t } : { id, time: t, copy },
      ].sort((a, b) => a.time - b.time),
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
      selectedCutIndex: null,
    });
  },

  copyWords: (ids) => {
    const s = get();
    const clipboard = snapshotSelection(
      s.words,
      s.manualCuts,
      s.sceneBoundaries,
      s.copies,
      s.duration,
      ids,
      "copy"
    );
    if (!clipboard) return null;
    set({ clipboard });
    return clipboard.text;
  },

  cutWords: (ids) => {
    const s = get();
    const clipboard = snapshotSelection(
      s.words,
      s.manualCuts,
      s.sceneBoundaries,
      s.copies,
      s.duration,
      ids,
      "cut"
    );
    if (!clipboard) return null;
    const idSet = new Set(ids);
    // Cutting is deleting until the words are pasted somewhere else.
    pushEdit(get, set, {
      clipboard,
      words: s.words.map((w) => (idSet.has(w.id) && !w.deleted ? { ...w, deleted: true } : w)),
      selectedCutIndex: null,
      selectedWordIds: [],
    });
    return clipboard.text;
  },

  pasteWords: (at) => {
    const s = get();
    if (!s.clipboard || s.duration <= 0) return false;
    const { state, moved, pastedIds } = pasteClipboard(
      {
        words: s.words,
        manualCuts: s.manualCuts,
        sceneBoundaries: s.sceneBoundaries,
        copies: s.copies,
      },
      s.clipboard,
      at,
      s.duration
    );
    pushEdit(get, set, {
      words: state.words,
      manualCuts: state.manualCuts,
      sceneBoundaries: state.sceneBoundaries,
      copies: state.copies,
      nextManualCutId: Math.max(s.nextManualCutId, maxId(state.manualCuts, 1)),
      nextBoundaryId: Math.max(s.nextBoundaryId, maxId(state.sceneBoundaries, 1)),
      clipboard: moved ? { ...s.clipboard, consumed: true } : s.clipboard,
      selectedClipIndex: null,
      selectedCutIndex: null,
      selectedWordIds: pastedIds,
    });
    return true;
  },

  trimEdge: (edge, from, to, copy) => {
    const s = get();
    const result = trimEdgeResult(
      wordsOfCopy(s.words, copy),
      ofCopy(s.manualCuts, copy),
      edge,
      from,
      to,
      s.nextManualCutId
    );
    if (!result) return;
    const words = editCopyWords(s.words, copy, () => result.words);
    const manualCuts = replaceCopyItems(s.manualCuts, copy, result.manualCuts);

    // A split point sitting on the dragged edge *is* that edge — it has to move
    // with it, or the span the drag reclaims becomes an orphan clip.
    const sceneBoundaries = replaceCopyItems(
      s.sceneBoundaries,
      copy,
      carrySceneBoundaries(ofCopy(s.sceneBoundaries, copy), from, to)
    ).sort((a, b) => a.time - b.time);

    // Clip indices shift whenever a trim merges or splits keep ranges, so
    // re-find the clip that owns the moved edge instead of keeping an index.
    const clips = getClipSegments(
      sequenceFor(words, manualCuts, s.copies, s.duration).pieces,
      sceneBoundaries
    ).filter((c) => c.copy === copy);
    const owner =
      clips.find((c) => Math.abs((edge === "in" ? c.start : c.end) - to) < 1e-3) ??
      clips.find((c) => to >= c.start && to <= c.end);

    pushEdit(get, set, {
      words,
      manualCuts,
      sceneBoundaries,
      nextManualCutId: result.nextCutId,
      selectedClipIndex: owner?.index ?? s.selectedClipIndex,
      selectedCutIndex: null,
    });
  },

  setSelectedClipIndex: (selectedClipIndex) =>
    set({
      selectedClipIndex,
      ...(selectedClipIndex != null ? { selectedCutIndex: null } : {}),
    }),

  setSelectedCutIndex: (selectedCutIndex) =>
    set({
      selectedCutIndex,
      ...(selectedCutIndex != null ? { selectedClipIndex: null } : {}),
    }),

  setSelectedWords: (selectedWordIds) =>
    set({
      selectedWordIds,
      // A fresh word selection from the transcript supersedes a prior cut pick.
      // Timeline cut-word clicks re-select the cut afterward.
      ...(selectedWordIds.length > 0 ? { selectedCutIndex: null } : {}),
    }),

  beginGesture: () => {
    const s = get();
    if (s.gestureActive) return;
    set({
      gestureActive: true,
      past: pushHistory(s.past, snapshotOf(s)),
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
    const s = get();
    const { past, future } = s;
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    set({
      ...snapshotOf(prev),
      currentPiece: null,
      past: past.slice(0, -1),
      future: [snapshotOf(s), ...future],
      selectedClipIndex: null,
      selectedCutIndex: null,
      selectedWordIds: [],
      gestureActive: false,
    });
    bumpAutosave();
  },
  redo: () => {
    const s = get();
    const { past, future } = s;
    if (future.length === 0) return;
    const next = future[0];
    set({
      ...snapshotOf(next),
      currentPiece: null,
      future: future.slice(1),
      past: pushHistory(past, snapshotOf(s)),
      selectedClipIndex: null,
      selectedCutIndex: null,
      selectedWordIds: [],
      gestureActive: false,
    });
    bumpAutosave();
  },
  toggleShowDeleted: () => {
    set((s) => ({ showDeleted: !s.showDeleted }));
    bumpAutosave();
  },

  setCurrentTime: (currentTime, copy, piece) =>
    set({
      currentTime,
      ...(copy === undefined ? {} : { currentCopy: copy }),
      ...(piece === undefined ? {} : { currentPiece: piece }),
    }),
  seekTo: (time, copy) => {
    const media = get().videoEl;
    if (media) media.currentTime = time;
    set({
      currentTime: time,
      ...(copy === undefined ? {} : { currentCopy: copy }),
      currentPiece: null,
    });
  },
  setPlaying: (playing) => set({ playing }),
  setVideoEl: (videoEl) => set({ videoEl }),
  togglePlayback: () => {
    const s = get();
    const media = s.videoEl;
    if (!media) return;
    if (media.paused) {
      // Start from the playhead's piece, skipping forward out of a cut; parked
      // at the end of the edit, start over.
      const seq = seqOf(s);
      const t = media.currentTime;
      let i = playheadPiece(seq, s.currentCopy, t, s.currentPiece);
      // Parked on a piece's end: what plays is the next one.
      if (i >= 0 && t >= seq.pieces[i].end - 1e-6) i += 1;
      if (i < 0 || i >= seq.pieces.length) i = 0;
      const piece = seq.pieces[i];
      if (!piece) return;
      const inside = piece.copy === s.currentCopy && t >= piece.start && t < piece.end;
      const start = inside ? t : piece.start + (piece.start > 0 ? PLAYHEAD_EPSILON_S : 0);
      if (!inside) media.currentTime = start;
      set({ currentTime: start, currentCopy: piece.copy, currentPiece: i });
      void media.play();
    } else {
      media.pause();
    }
  },
  setExportResult: (exportResult) => {
    const prev = get().exportResult;
    // Updating a result (e.g. recording where it was saved) keeps its file.
    if (prev && !(exportResult && sameExportResource(prev, exportResult))) {
      disposeExportResult(prev);
    }
    set({ exportResult });
  },
  setExportOpen: (exportOpen) => set({ exportOpen }),

  reset: () => {
    const { mediaUrl, videoFile, exportResult } = get();
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    releaseMediaResources(videoFile, exportResult);
    set({
      videoFile: null,
      mediaUrl: null,
      mediaKind: null,
      duration: 0,
      waveform: null,
      hasAudio: false,
      source: loadModelPreference(),
      transcriptLanguage: loadTranscriptLanguagePreference(),
      pendingTranscript: null,
      projectId: null,
      skipTranscription: false,
      status: "idle",
      progress: { message: "", value: null },
      partialText: "",
      error: null,
      words: [],
      speakers: [],
      manualCuts: [],
      sceneBoundaries: [],
      copies: [],
      clipboard: null,
      past: [],
      future: [],
      selectedClipIndex: null,
      selectedCutIndex: null,
      selectedWordIds: [],
      nextManualCutId: 1,
      nextBoundaryId: 1,
      gestureActive: false,
      currentTime: 0,
      currentCopy: 0,
      currentPiece: null,
      playing: false,
      exportResult: null,
      exportOpen: false,
    });
  },
}));

/**
 * Whether Split can cut the clip under the playhead: inside a kept piece, clear
 * of cut edges, existing splits and the piece's own ends.
 */
export function canSplitAtPlayhead(s: EditorState): boolean {
  const t = s.currentTime;
  const copy = s.currentCopy;
  const seq = seqOf(s);
  if (!canSplitAt(t, s.duration, cutsOf(seq, copy), ofCopy(s.sceneBoundaries, copy))) {
    return false;
  }
  const piece = seq.pieces[pieceAtOrAfter(seq, copy, t)];
  return (
    !!piece &&
    piece.copy === copy &&
    t > piece.start + SPLIT_EPSILON &&
    t < piece.end - SPLIT_EPSILON
  );
}

/** The word at the playhead — in the copy that is playing. */
export function activeWordOf(s: EditorState): number {
  const seq = seqOf(s);
  const run = playheadRun(seq, s.currentCopy, s.currentTime, s.currentPiece);
  return activeWordId(seq, s.words, s.currentCopy, s.currentTime, run);
}

/** Where the playhead is in the edited output (seconds). */
export function playheadEditedTime(s: EditorState): number {
  const seq = seqOf(s);
  const run = playheadRun(seq, s.currentCopy, s.currentTime, s.currentPiece);
  return run < 0 ? 0 : editedTimeInRun(seq, run, s.currentTime);
}

/** Where the playhead sits on the timeline's display axis (seconds). */
export function playheadDisplayTime(s: EditorState): number {
  const seq = seqOf(s);
  const run = playheadRun(seq, s.currentCopy, s.currentTime, s.currentPiece);
  return run < 0 ? 0 : displayTimeInRun(seq, run, s.currentTime);
}

/** The live edit in playback order, for code outside React. */
export function liveSequence(): Sequence {
  return seqOf(useEditorStore.getState());
}

/** Put the playhead on a word (just inside it, in its own copy). */
export function seekToWord(word: Word): void {
  useEditorStore.getState().seekTo(word.start + PLAYHEAD_EPSILON_S, copyOf(word));
}

/** Apply the stored model preference after mount (avoids SSR/localStorage mismatch). */
export function hydrateModelPreference() {
  const stored = loadModelPreference();
  const current = useEditorStore.getState().source;
  // Don't clobber an in-progress import selection.
  if (current === "import" || stored === current) return;
  useEditorStore.setState({ source: stored });
}

/** Apply the stored transcript language after mount (avoids SSR/localStorage mismatch). */
export function hydrateTranscriptLanguagePreference() {
  const stored = loadTranscriptLanguagePreference();
  if (stored !== useEditorStore.getState().transcriptLanguage) {
    useEditorStore.setState({ transcriptLanguage: stored });
  }
}

// DevTools / Playwright: inspect and drive the editor store from the console.
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  (window as unknown as { __rescriptStore?: typeof useEditorStore }).__rescriptStore =
    useEditorStore;
}
