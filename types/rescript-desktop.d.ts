/** Resting sizes the Electron shell switches between. */
export type WindowMode = "compact" | "expanded";

/**
 * SpeechAnalyzer payloads, mirrored from electron/ipc/channels.ts. The renderer
 * can't import from electron/ (different tsconfig + Node types), so the shapes
 * are declared structurally on both sides.
 */
export type SpeechAnalyzerCheckResult = {
  available: boolean;
  reason?: string;
  locale?: string;
  installedLocales?: string[];
  helperPath?: string | null;
};

export type SpeechAnalyzerProgress = {
  message: string;
  value: number | null;
};

export type SpeechAnalyzerTranscribeRequest = {
  path?: string;
  data?: ArrayBuffer;
  name?: string;
  locale?: string;
};

export type SpeechAnalyzerWord = {
  id: number;
  text: string;
  start: number;
  end: number;
  speaker: number;
  deleted: boolean;
};

export type SpeechAnalyzerTranscribeResult = {
  words: SpeechAnalyzerWord[];
  locale: string;
  duration: number;
  model: string;
};

/** Desktop bridge exposed by electron/preload.ts when running inside Electron. */
export interface RescriptDesktop {
  platform: NodeJS.Platform;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  /** Resize the shell: "compact" for the upload screen, "expanded" for the editor. */
  setWindowMode: (mode: WindowMode) => void;
  isFullScreen: () => Promise<boolean>;
  /** Subscribe to full-screen changes; returns an unsubscribe function. */
  onFullScreenChange: (callback: (value: boolean) => void) => () => void;
  speechAnalyzer?: {
    check: () => Promise<SpeechAnalyzerCheckResult>;
    transcribe: (
      req: SpeechAnalyzerTranscribeRequest
    ) => Promise<SpeechAnalyzerTranscribeResult>;
    onProgress: (handler: (progress: SpeechAnalyzerProgress) => void) => () => void;
  };
}

declare global {
  interface Window {
    rescriptDesktop?: RescriptDesktop;
  }
}

export {};
