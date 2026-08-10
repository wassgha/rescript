/** Renderer modes used by the Electron shell's two-step native Close behavior. */
export type WindowMode = "compact" | "expanded";

/** Actions the native File menu delegates to the renderer over IPC. Opening the
 *  file picker isn't one of them — a file chooser needs user activation, so the
 *  main process calls `window.rescriptOpenFilePicker` instead. */
export type MenuCommand =
  | { type: "open-project"; id: string }
  | { type: "clear-recents" }
  /** Leave the editor for the upload screen (an intercepted window close). */
  | { type: "close-project" };

/** Desktop bridge exposed by electron/preload.ts when running inside Electron. */
export interface RescriptDesktop {
  platform: NodeJS.Platform;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  /** Report whether the upload screen or editor is active; this does not resize the window. */
  setWindowMode: (mode: WindowMode) => void;
  /** Mirror the telemetry opt-out to the main process, which gates its own reporting. */
  setTelemetryEnabled: (enabled: boolean) => void;
  /** Publish the saved-project list (newest first) for File › Recent Projects. */
  setRecentProjects: (projects: Array<{ id: string; name: string }>) => void;
  /** Subscribe to File-menu actions; returns an unsubscribe function. */
  onMenuCommand: (callback: (command: MenuCommand) => void) => () => void;
  isFullScreen: () => Promise<boolean>;
  /** Subscribe to full-screen changes; returns an unsubscribe function. */
  onFullScreenChange: (callback: (value: boolean) => void) => () => void;
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
