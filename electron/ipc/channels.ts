/** IPC channel names shared by Electron main + preload. */
export const IPC = {
  speechAnalyzerCheck: "speechAnalyzer:check",
  speechAnalyzerTranscribe: "speechAnalyzer:transcribe",
  speechAnalyzerProgress: "speechAnalyzer:progress",
} as const;

export type SpeechAnalyzerCheckResult = {
  available: boolean;
  reason?: string;
  locale?: string;
  installedLocales?: string[];
  helperPath?: string | null;
};

export type SpeechAnalyzerWord = {
  id: number;
  text: string;
  start: number;
  end: number;
  speaker: number;
  deleted: boolean;
};

export type SpeechAnalyzerProgress = {
  message: string;
  value: number | null;
};

export type SpeechAnalyzerTranscribeRequest = {
  /** Absolute path to a media file on disk (preferred in Electron). */
  path?: string;
  /** Raw file bytes when no path is available (drag-drop without path). */
  data?: ArrayBuffer;
  /** Filename hint used when writing a temp file from `data`. */
  name?: string;
  locale?: string;
};

export type SpeechAnalyzerTranscribeResult = {
  words: SpeechAnalyzerWord[];
  locale: string;
  duration: number;
  model: string;
};
