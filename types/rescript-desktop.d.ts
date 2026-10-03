import type { UiLocale } from "@/lib/i18n/locales";
import type { ExportRequest } from "@/lib/exportArgs";

/** Resting sizes the Electron shell switches between. */
export type WindowMode = "compact" | "expanded";

/** Actions the native File menu delegates to the renderer over IPC. Opening the
 *  file picker isn't one of them — a file chooser needs user activation, so the
 *  main process calls `window.rescriptOpenFilePicker` instead. */
export type MenuCommand =
  | { type: "open-project"; id: string }
  | { type: "clear-recents" }
  /** Leave the editor for the upload screen (an intercepted window close). */
  | { type: "close-project" };

/** Why a native media call didn't succeed (mirrors `MediaFailure` in electron/media.ts). */
export type NativeMediaFailure =
  | "unavailable"
  | "failed"
  | "no-audio"
  | "cancelled"
  | "no-space"
  | "invalid";

export type NativeMediaResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; code: NativeMediaFailure; detail?: string };

/** Native ffmpeg in the Electron main process (electron/media.ts via preload). */
export interface RescriptDesktopMedia {
  /** Whether the bundled ffmpeg starts and has every encoder export needs. */
  probe: () => Promise<NativeMediaResult<{ version: string }>>;
  /** Disk path of a picked / dropped File; "" for one rebuilt from a Blob. */
  pathForFile: (file: File) => string;
  /** Use a file already on disk; fails unless its size (and mtime) still match. */
  registerPath: (
    path: string,
    size: number,
    mtime: number | null
  ) => Promise<NativeMediaResult<{ mediaId: string }>>;
  /** Copy a path-less File into the main process's temp dir. */
  stageFile: (
    file: File,
    onProgress?: (ratio: number) => void
  ) => Promise<NativeMediaResult<{ mediaId: string }>>;
  releaseMedia: (mediaId: string) => Promise<NativeMediaResult>;
  extractAudio: (
    mediaId: string
  ) => Promise<NativeMediaResult<{ pcmId: string; byteLength: number }>>;
  readPcm: (
    pcmId: string,
    offset: number,
    length: number
  ) => Promise<NativeMediaResult<{ data: Uint8Array }>>;
  releasePcm: (pcmId: string) => Promise<NativeMediaResult>;
  renderExport: (
    mediaId: string,
    request: ExportRequest,
    onProgress: (ratio: number) => void,
    onStart?: (jobId: string) => void
  ) => Promise<
    NativeMediaResult<{
      outputId: string;
      size: number;
      /** VideoToolbox decoded / encoded the render that succeeded. */
      hardwareDecode: boolean;
      hardwareEncode: boolean;
      /** Set when a hardware attempt failed and software finished the job. */
      fallback?: string;
    }>
  >;
  cancelExport: (jobId: string) => Promise<NativeMediaResult>;
  /** Native Save dialog, then move the render there. `cancelled` if dismissed. */
  saveExport: (
    outputId: string,
    defaultName: string,
    title: string
  ) => Promise<NativeMediaResult<{ name: string }>>;
  revealExport: (outputId: string) => Promise<NativeMediaResult>;
  discardExport: (outputId: string) => Promise<NativeMediaResult>;
}

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
  /** Mirror the telemetry opt-out to the main process, which gates its own reporting. */
  setTelemetryEnabled: (enabled: boolean) => void;
  /** Keep native menus and dialogs aligned with the resolved UI locale. */
  setUiLocale: (locale: UiLocale) => void;
  /** Publish the saved-project list (newest first) for File › Recent Projects. */
  setRecentProjects: (projects: Array<{ id: string; name: string }>) => void;
  /** Subscribe to File-menu actions; returns an unsubscribe function. */
  onMenuCommand: (callback: (command: MenuCommand) => void) => () => void;
  isFullScreen: () => Promise<boolean>;
  /** Subscribe to full-screen changes; returns an unsubscribe function. */
  onFullScreenChange: (callback: (value: boolean) => void) => () => void;
  /** Native media engine. Absent in desktop builds that predate it. */
  media?: RescriptDesktopMedia;
}

declare global {
  interface Window {
    rescriptDesktop?: RescriptDesktop;
    /** Opens the media picker. Set by the renderer, called by the main process
     *  through executeJavaScript so the dialog gets a user activation. */
    rescriptOpenFilePicker?: () => void;
  }
}

export {};
