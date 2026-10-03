import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

/** A DOM `File` handed over from the page (the electron tsconfig has no DOM lib). */
type PageFile = Parameters<typeof webUtils.getPathForFile>[0] & {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
};

type MediaResult = { ok: boolean; code?: string; detail?: string; [key: string]: unknown };

/** Chunk size for copying a path-less File into the main process. */
const STAGE_CHUNK_BYTES = 16 * 1024 * 1024;

let nextJobId = 0;

/**
 * Native media engine (electron/media.ts). Everything is referred to by ids
 * the main process issues; the page never sends it a path or an argv.
 */
const media = {
  probe: (): Promise<MediaResult> => ipcRenderer.invoke("media:probe"),
  /** Disk path of a picked / dropped File, or "" for one built from a Blob. */
  pathForFile: (file: PageFile): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  registerPath: (path: string, size: number, mtime: number | null): Promise<MediaResult> =>
    ipcRenderer.invoke("media:register-path", path, size, mtime),
  /**
   * Copy a File that has no disk path (a project restored from IndexedDB)
   * into the main process's temp dir. Done here rather than in the page so
   * each chunk is cloned once (into IPC) instead of twice.
   */
  stageFile: async (
    file: PageFile,
    onProgress?: (ratio: number) => void
  ): Promise<MediaResult> => {
    const begin: MediaResult = await ipcRenderer.invoke("media:stage-begin", file.name, file.size);
    if (!begin.ok) return begin;
    const stageId = begin.stageId as string;
    try {
      for (let offset = 0; offset < file.size; offset += STAGE_CHUNK_BYTES) {
        const chunk = new Uint8Array(
          await file.slice(offset, offset + STAGE_CHUNK_BYTES).arrayBuffer()
        );
        const res: MediaResult = await ipcRenderer.invoke("media:stage-chunk", stageId, chunk);
        if (!res.ok) {
          await ipcRenderer.invoke("media:stage-end", stageId, false);
          return res;
        }
        onProgress?.(Math.min(1, (offset + chunk.byteLength) / Math.max(1, file.size)));
      }
    } catch (err) {
      await ipcRenderer.invoke("media:stage-end", stageId, false);
      return { ok: false, code: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
    return ipcRenderer.invoke("media:stage-end", stageId, true);
  },
  releaseMedia: (mediaId: string): Promise<MediaResult> =>
    ipcRenderer.invoke("media:release", mediaId),
  extractAudio: (mediaId: string): Promise<MediaResult> =>
    ipcRenderer.invoke("media:extract-audio", mediaId),
  readPcm: (pcmId: string, offset: number, length: number): Promise<MediaResult> =>
    ipcRenderer.invoke("media:read-pcm", pcmId, offset, length),
  releasePcm: (pcmId: string): Promise<MediaResult> =>
    ipcRenderer.invoke("media:release-pcm", pcmId),
  /**
   * Render an export to a temp file. `onStart` receives the job id (for
   * `cancelExport`); progress arrives as a 0–1 ratio.
   */
  renderExport: async (
    mediaId: string,
    request: unknown,
    onProgress: (ratio: number) => void,
    onStart?: (jobId: string) => void
  ): Promise<MediaResult> => {
    const jobId = `${process.pid}-${++nextJobId}`;
    const listener = (_event: IpcRendererEvent, data: { jobId?: unknown; ratio?: unknown }) => {
      if (data?.jobId === jobId && typeof data.ratio === "number") onProgress(data.ratio);
    };
    ipcRenderer.on("export:progress", listener);
    onStart?.(jobId);
    try {
      return await ipcRenderer.invoke("export:render", jobId, mediaId, request);
    } finally {
      ipcRenderer.off("export:progress", listener);
    }
  },
  cancelExport: (jobId: string): Promise<MediaResult> =>
    ipcRenderer.invoke("export:cancel", jobId),
  saveExport: (outputId: string, defaultName: string, title: string): Promise<MediaResult> =>
    ipcRenderer.invoke("export:save", outputId, defaultName, title),
  revealExport: (outputId: string): Promise<MediaResult> =>
    ipcRenderer.invoke("export:reveal", outputId),
  discardExport: (outputId: string): Promise<MediaResult> =>
    ipcRenderer.invoke("export:discard", outputId),
};

/**
 * Minimal bridge for the renderer. Rescript's UI is still a normal web
 * surface; we only expose host metadata so the page can adapt chrome / skip
 * the COI service worker (headers come from the app:// protocol instead),
 * plus the few window controls the page drives (sizing, title-bar state).
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
  /**
   * Mirror the renderer's telemetry opt-out into the main process, which can't
   * read localStorage but needs the preference to gate its own crash reporting.
   */
  setTelemetryEnabled: (enabled: boolean) => {
    ipcRenderer.send("telemetry:set-enabled", enabled);
  },
  /** Keep native menus and dialogs in sync with the renderer preference. */
  setUiLocale: (locale: string) => {
    ipcRenderer.send("ui:set-locale", locale);
  },
  /**
   * Publish the saved-project list (newest first) so the main process can draw
   * it under File › Recent Projects. Only id + name are sent.
   */
  setRecentProjects: (projects: Array<{ id: string; name: string }>) => {
    ipcRenderer.send(
      "menu:set-recents",
      projects.map(({ id, name }) => ({ id, name }))
    );
  },
  /** Subscribe to File-menu actions; returns an unsubscribe function. */
  onMenuCommand: (callback: (command: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, command: unknown) => callback(command);
    ipcRenderer.on("menu:command", listener);
    // Tell the main process the page is listening, so commands fired at a
    // window that was opened *by* the menu aren't lost before mount.
    ipcRenderer.send("menu:renderer-ready");
    return () => {
      ipcRenderer.off("menu:command", listener);
    };
  },
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke("window:is-full-screen"),
  onFullScreenChange: (callback: (value: boolean) => void) => {
    const listener = (_event: IpcRendererEvent, value: boolean) => callback(value);
    ipcRenderer.on("window:full-screen-changed", listener);
    return () => {
      ipcRenderer.off("window:full-screen-changed", listener);
    };
  },
  media,
});
