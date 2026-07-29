import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC,
  type SpeechAnalyzerCheckResult,
  type SpeechAnalyzerProgress,
  type SpeechAnalyzerTranscribeRequest,
  type SpeechAnalyzerTranscribeResult,
} from "./ipc/channels";

/**
 * Minimal bridge for the renderer. Rescript's UI is still a normal web
 * surface; we only expose host metadata so the page can adapt chrome / skip
 * the COI service worker (headers come from the app:// protocol instead),
 * the few window controls the page drives (sizing, title-bar state), and the
 * SpeechAnalyzer helper IPC (macOS 26+).
 */
contextBridge.exposeInMainWorld("rescriptDesktop", {
  platform: process.platform as NodeJS.Platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  /** Switch between the compact upload window and the full editor window. */
  setWindowMode: (mode: "compact" | "expanded") => {
    ipcRenderer.send("window:set-mode", mode);
  },
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke("window:is-full-screen"),
  onFullScreenChange: (callback: (value: boolean) => void) => {
    const listener = (_event: IpcRendererEvent, value: boolean) => callback(value);
    ipcRenderer.on("window:full-screen-changed", listener);
    return () => {
      ipcRenderer.off("window:full-screen-changed", listener);
    };
  },

  speechAnalyzer: {
    check(): Promise<SpeechAnalyzerCheckResult> {
      return ipcRenderer.invoke(IPC.speechAnalyzerCheck);
    },
    transcribe(
      req: SpeechAnalyzerTranscribeRequest
    ): Promise<SpeechAnalyzerTranscribeResult> {
      return ipcRenderer.invoke(IPC.speechAnalyzerTranscribe, req);
    },
    onProgress(handler: (progress: SpeechAnalyzerProgress) => void): () => void {
      const listener = (_event: IpcRendererEvent, progress: SpeechAnalyzerProgress) => {
        handler(progress);
      };
      ipcRenderer.on(IPC.speechAnalyzerProgress, listener);
      return () => {
        ipcRenderer.removeListener(IPC.speechAnalyzerProgress, listener);
      };
    },
  },
});
