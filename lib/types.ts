/** A single transcribed word, timed against the original media. */
export interface Word {
  id: number;
  /** The word text (no surrounding whitespace). */
  text: string;
  /** Start time in seconds, in original media time. */
  start: number;
  /** End time in seconds, in original media time. */
  end: number;
  /** Sequential speaker index (0-based). -1 when unknown. */
  speaker: number;
  /** Deleted words are cut out of the video. */
  deleted: boolean;
}

/** A half-open time range [start, end) in original media seconds. */
export interface TimeRange {
  start: number;
  end: number;
}

/**
 * A user-placed cut that is not owned by a deleted word.
 * Used for blade/trim edits after splitting clips.
 */
export interface ManualCut {
  id: number;
  start: number;
  end: number;
}

/**
 * A structural split point in original media time.
 * Subdivides keep ranges into independently selectable clips (Descript-style scenes).
 */
export interface SceneBoundary {
  id: number;
  time: number;
}

/** Named speaker in the project (id matches Word.speaker). */
export interface SpeakerInfo {
  id: number;
  name: string;
}

/** Snapshot of all edit state for undo/redo. */
export interface EditSnapshot {
  words: Word[];
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
  speakers: SpeakerInfo[];
}

/** A contiguous kept segment of media, optionally subdivided by scene boundaries. */
export interface ClipSegment {
  /** Stable key for React / selection (`start` fixed at creation is not stable after trim). */
  id: string;
  start: number;
  end: number;
  index: number;
}

/** Consecutive words spoken by the same speaker (derived for rendering). */
export interface SpeakerTurn {
  speaker: number;
  words: Word[];
}

export type EditorStatus =
  | "idle" // no video loaded
  | "preparing" // loading ffmpeg / extracting audio
  | "transcribing" // whisper + diarization running
  | "ready" // editable
  | "exporting"
  | "error";

export interface ProgressInfo {
  /** Short human-readable description of the current step. */
  message: string;
  /** 0..1, or null for indeterminate. */
  value: number | null;
}

/** Messages posted from the transcription worker to the main thread. */
export type WorkerResponse =
  | { type: "progress"; message: string; value: number | null }
  | { type: "partial"; text: string }
  | { type: "complete"; words: Word[] }
  /**
   * `cause` marks failures whose origin is the user's environment rather than
   * the app, so the main thread can skip crash reporting for them.
   */
  | { type: "error"; message: string; cause?: "network" };

export interface WorkerRequest {
  audio: Float32Array;
  /** Total media duration in seconds (used for progress estimation). */
  duration: number;
  /** Which local speech model to use (see lib/models.ts). */
  model: import("./models").ModelId;
  /**
   * Transcript language: conditions Whisper decoding, selects the CTC aligner,
   * and is passed through for Parakeet alignment (Parakeet ASR still auto-detects).
   */
  language: import("./languages").TranscriptLanguage;
  /** Optional speaker-cap setting for diarization post-processing. */
  maxSpeakers?: number;
  /** Optional diarization onset confidence threshold. */
  onsetThreshold?: number;
}
