/**
 * Desktop media engine: native ffmpeg in the main process, behind IPC.
 *
 * The renderer's ffmpeg.wasm tops out at a 2 GiB heap and keeps the whole
 * encoded output in memory, so long or high-resolution exports died with
 * "memory access out of bounds" / the stall watchdog. Here ffmpeg reads the
 * source straight off disk and writes the render to a temp file; the user
 * then moves it wherever they like with a native Save dialog.
 *
 * The renderer never hands us a path to act on or an argv to run. Media,
 * PCM and rendered outputs are referred to by opaque ids this module issues,
 * and the ffmpeg command is built here from a validated request — so a
 * compromised page can't use this to read, overwrite or delete arbitrary files.
 *
 * Every handler resolves to a result object instead of throwing: errors thrown
 * across `ipcMain.handle` arrive as "Error invoking remote method…" strings,
 * which would lose both the failure kind (fall back to wasm or not) and the
 * stderr the renderer reports to Sentry.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import {
  copyFile,
  open,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import {
  AUDIO_STREAM_RE,
  buildAudioExport,
  buildVideoExport,
  extractAudioArgs,
  parseExportRequest,
  progressRatio,
} from "../lib/exportArgs";
import {
  nativeExportArgs,
  probeFFmpeg,
  resolveBinary,
  runFFmpeg,
  type RunOutcome,
} from "./ffmpegRunner";

/** Failure kinds the renderer distinguishes (see lib/nativeMedia.ts). */
export type MediaFailure =
  | "unavailable"
  | "failed"
  | "no-audio"
  | "cancelled"
  | "no-space"
  | "invalid";

type Fail = { ok: false; code: MediaFailure; detail?: string };

/** Largest chunk the renderer may stage or read in one IPC message. */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/** File.lastModified is integer ms of the same stat; allow for coarse filesystems. */
const MTIME_TOLERANCE_MS = 2000;

interface MediaEntry {
  path: string;
  /** Copied in by us (and deleted on release) rather than the user's own file. */
  staged: boolean;
  owner: number;
}

interface StageEntry {
  handle: FileHandle;
  path: string;
  expected: number;
  written: number;
  owner: number;
}

interface PcmEntry {
  path: string;
  size: number;
  owner: number;
}

interface OutputEntry {
  /** Where the bytes currently are: the temp render, or where the user saved it. */
  path: string;
  ext: string;
  saved: boolean;
  owner: number;
}

const media = new Map<string, MediaEntry>();
const stages = new Map<string, StageEntry>();
const pcms = new Map<string, PcmEntry>();
const outputs = new Map<string, OutputEntry>();
const jobs = new Map<string, { controller: AbortController; owner: number }>();

let binary: string | null = null;
let probe: Promise<{ ok: true; version: string } | Fail> | null = null;
let lastSaveDir: string | null = null;

const ROOT_NAME = "rescript-media";
let sessionDir: string | null = null;

function tempRoot(): string {
  return join(app.getPath("temp"), ROOT_NAME);
}

function workDir(): string {
  if (!sessionDir) {
    sessionDir = join(tempRoot(), `${Date.now()}-${process.pid}`);
  }
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function tempPath(ext: string): string {
  return join(workDir(), `${randomUUID()}${ext}`);
}

/**
 * Previous sessions' leftovers — a crash or force-quit skips will-quit. The
 * single-instance lock in main.ts means no other live process owns them.
 */
function sweepStaleSessions(): void {
  const root = tempRoot();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(root, name);
    if (path === sessionDir) continue;
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already gone.
  }
}

/** Keep a safe extension so containers ffmpeg probes by name still open. */
function safeExtension(name: unknown): string {
  if (typeof name !== "string") return "";
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

/** A file name the Save dialog can propose; never a path. */
function safeFileName(name: unknown, ext: string): string {
  const raw = typeof name === "string" ? basename(name) : "";
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned || `export.${ext}`;
}

function isNoSpace(outcome: RunOutcome): boolean {
  return /No space left on device|ENOSPC|There is not enough space/i.test(outcome.stderrTail);
}

function failFromRun(outcome: Extract<RunOutcome, { ok: false }>): Fail {
  const detail = `${outcome.detail}\n${outcome.stderrTail.slice(-4000)}`;
  if (outcome.code === "failed" && isNoSpace(outcome)) {
    return { ok: false, code: "no-space", detail };
  }
  return { ok: false, code: outcome.code, detail };
}

function ioFail(err: unknown): Fail {
  const code = (err as NodeJS.ErrnoException)?.code;
  return {
    ok: false,
    code: code === "ENOSPC" ? "no-space" : "failed",
    detail: err instanceof Error ? err.message : String(err),
  };
}

async function ensureAvailable(): Promise<{ ok: true; version: string } | Fail> {
  if (!probe) {
    probe = (async () => {
      if (!binary) {
        return { ok: false, code: "unavailable", detail: "native ffmpeg disabled" } as Fail;
      }
      const result = await probeFFmpeg(binary);
      return result.ok
        ? result
        : ({ ok: false, code: "unavailable", detail: `${binary}: ${result.detail}` } as Fail);
    })();
  }
  return probe;
}

function ownedMedia(event: IpcMainInvokeEvent, id: unknown): MediaEntry | null {
  if (typeof id !== "string") return null;
  const entry = media.get(id);
  return entry && entry.owner === event.sender.id ? entry : null;
}

function ownedOutput(event: IpcMainInvokeEvent, id: unknown): OutputEntry | null {
  if (typeof id !== "string") return null;
  const entry = outputs.get(id);
  return entry && entry.owner === event.sender.id ? entry : null;
}

async function releaseMedia(id: string): Promise<void> {
  const entry = media.get(id);
  if (!entry) return;
  media.delete(id);
  if (entry.staged) await removeQuietly(entry.path);
}

async function discardOutput(id: string): Promise<void> {
  const entry = outputs.get(id);
  if (!entry) return;
  outputs.delete(id);
  if (!entry.saved) await removeQuietly(entry.path);
}

/**
 * Drop everything a renderer owned. Called when it navigates or goes away, so a
 * reload can't strand running encodes or temp files until quit.
 */
async function forgetOwner(owner: number): Promise<void> {
  for (const [id, job] of jobs) {
    if (job.owner === owner) {
      job.controller.abort();
      jobs.delete(id);
    }
  }
  for (const [id, entry] of stages) {
    if (entry.owner !== owner) continue;
    stages.delete(id);
    await entry.handle.close().catch(() => {});
    await removeQuietly(entry.path);
  }
  for (const [id, entry] of pcms) {
    if (entry.owner !== owner) continue;
    pcms.delete(id);
    await removeQuietly(entry.path);
  }
  for (const [id, entry] of media) if (entry.owner === owner) await releaseMedia(id);
  for (const [id, entry] of outputs) if (entry.owner === owner) await discardOutput(id);
}

function watchOwner(contents: WebContents): void {
  const id = contents.id;
  contents.on("did-start-navigation", (event) => {
    if (event.isSameDocument || !event.isMainFrame) return;
    void forgetOwner(id);
  });
  contents.on("render-process-gone", () => void forgetOwner(id));
  contents.on("destroyed", () => void forgetOwner(id));
}

export function registerMediaIpc(): void {
  binary = resolveBinary({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: app.getAppPath(),
  });

  app.on("web-contents-created", (_event, contents) => watchOwner(contents));
  app.on("will-quit", () => {
    for (const job of jobs.values()) job.controller.abort();
    jobs.clear();
    if (sessionDir) rmSync(sessionDir, { recursive: true, force: true, maxRetries: 3 });
  });
  void app.whenReady().then(sweepStaleSessions);

  ipcMain.handle("media:probe", async () => ensureAvailable());

  /** Use a file already on disk: one the user picked, or a restored project's original. */
  ipcMain.handle(
    "media:register-path",
    async (event, path: unknown, size: unknown, mtime: unknown) => {
      const available = await ensureAvailable();
      if (!available.ok) return available;
      if (typeof path !== "string" || !isAbsolute(path)) {
        return { ok: false, code: "invalid" } satisfies Fail;
      }
      try {
        const info = await stat(path);
        // A moved, replaced or edited original must not stand in for the
        // bytes the project was made from; the caller stages a copy instead.
        if (!info.isFile() || info.size !== size) {
          return { ok: false, code: "invalid" } satisfies Fail;
        }
        if (typeof mtime === "number" && Math.abs(info.mtimeMs - mtime) > MTIME_TOLERANCE_MS) {
          return { ok: false, code: "invalid" } satisfies Fail;
        }
      } catch {
        return { ok: false, code: "invalid" } satisfies Fail;
      }
      const id = randomUUID();
      media.set(id, { path, staged: false, owner: event.sender.id });
      return { ok: true, mediaId: id };
    }
  );

  /** Copy a File with no disk path (restored from IndexedDB) into the session dir. */
  ipcMain.handle("media:stage-begin", async (event, name: unknown, size: unknown) => {
    const available = await ensureAvailable();
    if (!available.ok) return available;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      return { ok: false, code: "invalid" } satisfies Fail;
    }
    const path = tempPath(safeExtension(name));
    try {
      const handle = await open(path, "w");
      const id = randomUUID();
      stages.set(id, { handle, path, expected: size, written: 0, owner: event.sender.id });
      return { ok: true, stageId: id };
    } catch (err) {
      return ioFail(err);
    }
  });

  ipcMain.handle("media:stage-chunk", async (event, id: unknown, chunk: unknown) => {
    const entry = typeof id === "string" ? stages.get(id) : undefined;
    if (!entry || entry.owner !== event.sender.id) {
      return { ok: false, code: "invalid" } satisfies Fail;
    }
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_CHUNK_BYTES) {
      return { ok: false, code: "invalid" } satisfies Fail;
    }
    if (entry.written + chunk.byteLength > entry.expected) {
      return { ok: false, code: "invalid" } satisfies Fail;
    }
    try {
      await entry.handle.write(chunk, 0, chunk.byteLength, entry.written);
      entry.written += chunk.byteLength;
      return { ok: true };
    } catch (err) {
      return ioFail(err);
    }
  });

  ipcMain.handle("media:stage-end", async (event, id: unknown, commit: unknown) => {
    const entry = typeof id === "string" ? stages.get(id) : undefined;
    if (!entry || entry.owner !== event.sender.id) {
      return { ok: false, code: "invalid" } satisfies Fail;
    }
    stages.delete(id as string);
    await entry.handle.close().catch(() => {});
    if (commit !== true || entry.written !== entry.expected) {
      await removeQuietly(entry.path);
      return { ok: false, code: commit === true ? "invalid" : "cancelled" } satisfies Fail;
    }
    const mediaId = randomUUID();
    media.set(mediaId, { path: entry.path, staged: true, owner: event.sender.id });
    return { ok: true, mediaId };
  });

  ipcMain.handle("media:release", async (event, id: unknown) => {
    if (ownedMedia(event, id)) await releaseMedia(id as string);
    return { ok: true };
  });

  /** Mono 16 kHz f32 PCM, written to a temp file the renderer then reads in chunks. */
  ipcMain.handle("media:extract-audio", async (event, id: unknown) => {
    const entry = ownedMedia(event, id);
    if (!entry) return { ok: false, code: "invalid" } satisfies Fail;
    const available = await ensureAvailable();
    if (!available.ok || !binary) return available;

    const out = tempPath(".f32");
    let sawAudio = false;
    const jobId = randomUUID();
    const controller = new AbortController();
    jobs.set(jobId, { controller, owner: event.sender.id });
    const outcome = await runFFmpeg(binary, extractAudioArgs(entry.path, out), {
      signal: controller.signal,
      onStderrLine: (line) => {
        if (AUDIO_STREAM_RE.test(line)) sawAudio = true;
      },
    });
    jobs.delete(jobId);
    if (!outcome.ok) {
      await removeQuietly(out);
      // No audio stream: "Output file does not contain any stream" — not an error.
      if (outcome.code === "failed" && !sawAudio) {
        return { ok: false, code: "no-audio" } satisfies Fail;
      }
      return failFromRun(outcome);
    }
    try {
      const { size } = await stat(out);
      if (size < 4) {
        await removeQuietly(out);
        return { ok: false, code: "no-audio" } satisfies Fail;
      }
      const pcmId = randomUUID();
      pcms.set(pcmId, { path: out, size, owner: event.sender.id });
      return { ok: true, pcmId, byteLength: size };
    } catch (err) {
      return ioFail(err);
    }
  });

  ipcMain.handle(
    "media:read-pcm",
    async (event, id: unknown, offset: unknown, length: unknown) => {
      const entry = typeof id === "string" ? pcms.get(id) : undefined;
      if (!entry || entry.owner !== event.sender.id) {
        return { ok: false, code: "invalid" } satisfies Fail;
      }
      if (
        typeof offset !== "number" ||
        typeof length !== "number" ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length <= 0 ||
        length > MAX_CHUNK_BYTES
      ) {
        return { ok: false, code: "invalid" } satisfies Fail;
      }
      const size = Math.min(length, Math.max(0, entry.size - offset));
      let handle: FileHandle | null = null;
      try {
        handle = await open(entry.path, "r");
        const buf = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buf, 0, size, offset);
        return { ok: true, data: new Uint8Array(buf.buffer, buf.byteOffset, bytesRead) };
      } catch (err) {
        return ioFail(err);
      } finally {
        await handle?.close().catch(() => {});
      }
    }
  );

  ipcMain.handle("media:release-pcm", async (event, id: unknown) => {
    const entry = typeof id === "string" ? pcms.get(id) : undefined;
    if (entry && entry.owner === event.sender.id) {
      pcms.delete(id as string);
      await removeQuietly(entry.path);
    }
    return { ok: true };
  });

  ipcMain.handle(
    "export:render",
    async (event, jobId: unknown, mediaId: unknown, rawRequest: unknown) => {
      const entry = ownedMedia(event, mediaId);
      const request = parseExportRequest(rawRequest);
      if (!entry || !request || typeof jobId !== "string" || jobs.has(jobId)) {
        return { ok: false, code: "invalid" } satisfies Fail;
      }
      const available = await ensureAvailable();
      if (!available.ok || !binary) return available;

      const plan =
        request.kind === "video"
          ? buildVideoExport(request.keepRanges, request.options, { x264Preset: "veryfast" })
          : buildAudioExport(request.keepRanges, request.options);
      const out = tempPath(`.${plan.ext}`);
      const graphPath = tempPath(".txt");
      try {
        await writeFile(graphPath, plan.filter, "utf8");
      } catch (err) {
        return ioFail(err);
      }

      const controller = new AbortController();
      const owner = event.sender;
      jobs.set(jobId, { controller, owner: owner.id });
      let lastSent = -1;
      const outcome = await runFFmpeg(
        binary,
        nativeExportArgs(entry.path, graphPath, plan, out),
        {
          signal: controller.signal,
          onProgress: (seconds) => {
            const ratio = progressRatio(seconds, request.editedDuration);
            // A few hundred updates per export is plenty for a progress bar.
            if (ratio - lastSent < 0.002 && ratio < 1) return;
            lastSent = ratio;
            if (!owner.isDestroyed()) owner.send("export:progress", { jobId, ratio });
          },
        }
      );
      jobs.delete(jobId);
      await removeQuietly(graphPath);
      if (!outcome.ok) {
        await removeQuietly(out);
        return failFromRun(outcome);
      }
      try {
        const { size } = await stat(out);
        const outputId = randomUUID();
        outputs.set(outputId, { path: out, ext: plan.ext, saved: false, owner: owner.id });
        return { ok: true, outputId, size };
      } catch (err) {
        return ioFail(err);
      }
    }
  );

  ipcMain.handle("export:cancel", async (event, jobId: unknown) => {
    const job = typeof jobId === "string" ? jobs.get(jobId) : undefined;
    if (job && job.owner === event.sender.id) job.controller.abort();
    return { ok: true };
  });

  /**
   * Ask where to put a finished render and move it there. A second Save of the
   * same output copies from wherever the first one put it.
   */
  ipcMain.handle(
    "export:save",
    async (event, outputId: unknown, defaultName: unknown, title: unknown) => {
      const entry = ownedOutput(event, outputId);
      if (!entry) return { ok: false, code: "invalid" } satisfies Fail;
      const win = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.SaveDialogOptions = {
        title: typeof title === "string" ? title : undefined,
        defaultPath: join(
          lastSaveDir ?? app.getPath("downloads"),
          safeFileName(defaultName, entry.ext)
        ),
        filters: [{ name: entry.ext.toUpperCase(), extensions: [entry.ext] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return { ok: false, code: "cancelled" } satisfies Fail;
      }
      let dest = result.filePath;
      // Linux dialogs don't always append the filter's extension.
      if (!extname(dest)) dest += `.${entry.ext}`;
      if (dest === entry.path) return { ok: true, name: basename(dest) };
      try {
        if (entry.saved) {
          await copyFile(entry.path, dest);
        } else {
          try {
            await rename(entry.path, dest);
          } catch (err) {
            // Across volumes (EXDEV), or a scanner holding the temp file on
            // Windows (EPERM/EBUSY): copy, then drop the temp.
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "EXDEV" && code !== "EPERM" && code !== "EBUSY") throw err;
            await copyFile(entry.path, dest);
            await removeQuietly(entry.path);
          }
        }
      } catch (err) {
        return ioFail(err);
      }
      entry.path = dest;
      entry.saved = true;
      lastSaveDir = dirname(dest);
      return { ok: true, name: basename(dest) };
    }
  );

  ipcMain.handle("export:reveal", async (event, outputId: unknown) => {
    const entry = ownedOutput(event, outputId);
    if (!entry || !entry.saved) return { ok: false, code: "invalid" } satisfies Fail;
    try {
      statSync(entry.path);
    } catch {
      return { ok: false, code: "invalid" } satisfies Fail;
    }
    shell.showItemInFolder(entry.path);
    return { ok: true };
  });

  ipcMain.handle("export:discard", async (event, outputId: unknown) => {
    if (ownedOutput(event, outputId)) await discardOutput(outputId as string);
    return { ok: true };
  });
}
