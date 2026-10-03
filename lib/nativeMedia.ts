"use client";

/**
 * Renderer side of the desktop media engine: native ffmpeg in the Electron
 * main process (electron/media.ts), reached through `rescriptDesktop.media`.
 *
 * Callers go through lib/mediaEngine.ts, which falls back to ffmpeg.wasm when
 * this throws {@link NativeUnavailableError}.
 */
import { en } from "@/lib/i18n/messages/en";
import { reportError } from "./sentry";
import type { ExportRequest } from "./exportArgs";
import type {
  NativeMediaFailure,
  NativeMediaResult,
  RescriptDesktopMedia,
} from "@/types/rescript-desktop";

/** The bundled binary can't run here; use ffmpeg.wasm instead. */
export class NativeUnavailableError extends Error {
  constructor(readonly detail: string) {
    super("Native media engine unavailable");
    this.name = "NativeUnavailableError";
  }
}

/**
 * A native job that ran and failed. `message` is the user-facing string;
 * `detail` (ffmpeg's stderr tail) goes to Sentry via reportError.
 */
export class NativeMediaError extends Error {
  constructor(
    message: string,
    readonly code: NativeMediaFailure,
    readonly detail?: string
  ) {
    super(message);
    this.name = "NativeMediaError";
  }
}

/** Where a restored project's media lives on disk, as last seen. */
export interface SourceHint {
  path: string;
  size: number;
  mtime: number;
}

/** PCM is pulled across IPC in chunks: three hours of it is ~690 MB. */
const PCM_CHUNK_BYTES = 32 * 1024 * 1024;

function bridge(): RescriptDesktopMedia | null {
  return typeof window === "undefined" ? null : window.rescriptDesktop?.media ?? null;
}

let availability: Promise<boolean> | null = null;
let unavailableDetail: string | null = null;

/** Probe once per session whether the native engine can be used. */
export function nativeMediaAvailable(): Promise<boolean> {
  if (!availability) {
    const media = bridge();
    availability = media
      ? media.probe().then(
          (res) => {
            if (!res.ok) unavailableDetail = res.detail ?? res.code;
            return res.ok;
          },
          (err: unknown) => {
            unavailableDetail = err instanceof Error ? err.message : String(err);
            return false;
          }
        )
      : Promise.resolve(false);
  }
  return availability;
}

/** Why the probe said no, for the fallback report. */
export function nativeUnavailableReason(): string | null {
  return unavailableDetail;
}

/** Stop using native for the rest of the session (it failed in a way wasm may not). */
export function disableNativeMedia(detail: string): void {
  unavailableDetail = detail;
  availability = Promise.resolve(false);
}

function requireBridge(): RescriptDesktopMedia {
  const media = bridge();
  if (!media) throw new NativeUnavailableError("no desktop bridge");
  return media;
}

/** Turn a failed result into the right error; `unavailable` → fall back. */
function fail(
  res: Extract<NativeMediaResult, { ok: false }>,
  message: string
): never {
  if (res.code === "unavailable") throw new NativeUnavailableError(res.detail ?? "unavailable");
  if (res.code === "no-space") throw new NativeMediaError(en["error.diskFull"], res.code, res.detail);
  throw new NativeMediaError(message, res.code, res.detail);
}

const sourceHints = new WeakMap<File, SourceHint>();
const mediaIds = new WeakMap<File, Promise<string>>();

/** Remember where a restored project's original lives, so it isn't copied. */
export function setSourceHint(file: File, hint: SourceHint): void {
  sourceHints.set(file, hint);
}

/**
 * The on-disk original behind `file`, if any: its picked path, or the hint a
 * restored project carried. Autosave stores this with the project.
 */
export function sourceHintFor(file: File): SourceHint | null {
  const known = sourceHints.get(file);
  if (known) return known;
  const path = bridge()?.pathForFile(file);
  if (!path) return null;
  const hint = { path, size: file.size, mtime: file.lastModified };
  sourceHints.set(file, hint);
  return hint;
}

/** Told `true` when a path-less file starts being copied, `false` once it's done. */
export type StagingListener = (staging: boolean) => void;

async function resolveMediaId(file: File, onStaging?: StagingListener): Promise<string> {
  const media = requireBridge();
  const hint = sourceHintFor(file);
  if (hint && hint.size === file.size) {
    const res = await media.registerPath(hint.path, hint.size, hint.mtime);
    if (res.ok) return res.mediaId;
    if (res.code === "unavailable") fail(res, en["error.processFile"]);
    // Moved, edited or deleted since — fall through and copy the saved bytes.
  }
  onStaging?.(true);
  const staged = await media.stageFile(file);
  onStaging?.(false);
  if (!staged.ok) fail(staged, en["error.processFile"]);
  return staged.mediaId;
}

/** Media id for `file`, registering or staging it on first use. */
function mediaIdFor(file: File, onStaging?: StagingListener): Promise<string> {
  let pending = mediaIds.get(file);
  if (!pending) {
    pending = resolveMediaId(file, onStaging);
    mediaIds.set(file, pending);
    pending.catch(() => {
      if (mediaIds.get(file) === pending) mediaIds.delete(file);
    });
  }
  return pending;
}

/** Hand back a file's registration (and delete its staged copy, if any). */
export function releaseNativeMedia(file: File | null): void {
  if (!file) return;
  const pending = mediaIds.get(file);
  if (!pending) return;
  mediaIds.delete(file);
  void pending.then(
    (id) => bridge()?.releaseMedia(id),
    () => {}
  );
}

/** Same contract as `extractAudio` in lib/ffmpeg.ts, run natively. */
export async function nativeExtractAudio(
  file: File,
  onStaging?: StagingListener
): Promise<Float32Array | null> {
  const media = requireBridge();
  const mediaId = await mediaIdFor(file, onStaging);
  const res = await media.extractAudio(mediaId);
  if (!res.ok) {
    if (res.code === "no-audio") return null;
    fail(res, en["error.extractAudio"]);
  }
  const { pcmId, byteLength } = res;
  try {
    // Assembled here, in the page: anything built in the preload would be
    // copied again on its way through contextBridge.
    const samples = new Float32Array(Math.floor(byteLength / 4));
    const bytes = new Uint8Array(samples.buffer);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const length = Math.min(PCM_CHUNK_BYTES, bytes.byteLength - offset);
      const chunk = await media.readPcm(pcmId, offset, length);
      if (!chunk.ok) fail(chunk, en["error.extractAudio"]);
      if (chunk.data.byteLength === 0) break;
      bytes.set(chunk.data, offset);
      offset += chunk.data.byteLength;
    }
    return samples;
  } finally {
    void media.releasePcm(pcmId);
  }
}

const activeJobs = new Set<string>();

/** A finished native render, waiting in the main process's temp dir. */
export interface NativeExport {
  outputId: string;
  size: number;
  hardwareDecode: boolean;
  hardwareEncode: boolean;
}

export async function nativeRenderExport(
  file: File,
  request: ExportRequest,
  onProgress: (ratio: number) => void
): Promise<NativeExport> {
  const media = requireBridge();
  const mediaId = await mediaIdFor(file);
  let jobId: string | null = null;
  try {
    const res = await media.renderExport(mediaId, request, onProgress, (id) => {
      jobId = id;
      activeJobs.add(id);
    });
    if (!res.ok) {
      fail(res, en[request.kind === "audio" ? "error.audioExport" : "error.videoExport"]);
    }
    if (res.fallback) {
      // The user got their file, from the software retry. Still worth
      // knowing: every such export took the slow path, and the stderr says why.
      reportError(
        new NativeMediaError("Hardware export failed; used software", "failed", res.fallback),
        "native-hw-fallback"
      );
    }
    return {
      outputId: res.outputId,
      size: res.size,
      hardwareDecode: res.hardwareDecode,
      hardwareEncode: res.hardwareEncode,
    };
  } finally {
    if (jobId) activeJobs.delete(jobId);
  }
}

/** Kill every running native job (project closed / replaced mid-export). */
export function cancelNativeJobs(): void {
  const media = bridge();
  if (!media) return;
  for (const id of activeJobs) void media.cancelExport(id);
  activeJobs.clear();
}

/**
 * Native Save dialog for a finished render. Resolves to the saved file's name,
 * or null if the user dismissed the dialog.
 */
export async function saveNativeExport(
  outputId: string,
  defaultName: string,
  title: string
): Promise<string | null> {
  const res = await requireBridge().saveExport(outputId, defaultName, title);
  if (res.ok) return res.name;
  if (res.code === "cancelled") return null;
  fail(res, en["error.exportSave"]);
}

export async function revealNativeExport(outputId: string): Promise<void> {
  await bridge()?.revealExport(outputId);
}

export function discardNativeExport(outputId: string): void {
  void bridge()?.discardExport(outputId);
}
