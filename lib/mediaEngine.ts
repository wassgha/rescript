"use client";

/**
 * One entry point for media work, whichever engine runs it.
 *
 * The desktop app renders with native ffmpeg (lib/nativeMedia.ts): no wasm
 * heap ceiling, input read straight off disk, output written to a file. The
 * web build — and a desktop install whose bundled binary won't start — uses
 * ffmpeg.wasm (lib/ffmpeg.ts). Only "the binary can't run" falls back; a job
 * native ffmpeg rejected would fail in wasm too, just slower.
 */
import { reportError } from "./sentry";
import * as wasm from "./ffmpeg";
import type {
  AudioExportFormat,
  ExportRequest,
  VideoExportFormat,
  VideoExportResolution,
} from "./exportArgs";
import type { TimeRange } from "./types";
import {
  disableNativeMedia,
  nativeExtractAudio,
  nativeMediaAvailable,
  nativeRenderExport,
  nativeUnavailableReason,
  NativeUnavailableError,
  type NativeExport,
  type StagingListener,
} from "./nativeMedia";

export type MediaEngine = "native" | "wasm";

export type MediaExportResult =
  | { engine: "wasm"; blob: Blob }
  | ({ engine: "native" } & NativeExport);

export type MediaExportOptions =
  | {
      kind: "video";
      withAudio: boolean;
      format: VideoExportFormat;
      resolution: VideoExportResolution;
    }
  | { kind: "audio"; format: AudioExportFormat };

let reportedProbe = false;

/** Which engine the next job will use. */
export async function activeMediaEngine(): Promise<MediaEngine> {
  if (await nativeMediaAvailable()) return "native";
  // A desktop build whose binary didn't pass the probe is worth knowing about
  // (once): it means every desktop export there is back on the wasm heap.
  const reason = nativeUnavailableReason();
  if (reason && !reportedProbe) {
    reportedProbe = true;
    reportError(new NativeUnavailableError(reason), "native-media-fallback");
  }
  return "wasm";
}

function fallBack(err: NativeUnavailableError): void {
  disableNativeMedia(err.detail);
  reportedProbe = true;
  reportError(err, "native-media-fallback");
}

/**
 * Mono 16 kHz float PCM of `file`'s audio track, or null when it has none.
 * `onStaging` brackets the copy the native engine makes first when the media
 * has no file on disk (a restored project whose original moved).
 */
export async function extractAudio(
  file: File,
  onStaging?: StagingListener
): Promise<Float32Array | null> {
  if ((await activeMediaEngine()) === "native") {
    try {
      return await nativeExtractAudio(file, onStaging);
    } catch (err) {
      if (!(err instanceof NativeUnavailableError)) throw err;
      fallBack(err);
    }
  }
  return wasm.extractAudio(file);
}

/** Render the edit: keep only `keepRanges` of `file`, re-encoded as `options`. */
export async function exportMedia(
  file: File,
  keepRanges: TimeRange[],
  editedDuration: number,
  onProgress: (ratio: number) => void,
  options: MediaExportOptions
): Promise<MediaExportResult> {
  if ((await activeMediaEngine()) === "native") {
    const request: ExportRequest =
      options.kind === "video"
        ? {
            kind: "video",
            keepRanges,
            editedDuration,
            options: {
              withAudio: options.withAudio,
              format: options.format,
              resolution: options.resolution,
            },
          }
        : { kind: "audio", keepRanges, editedDuration, options: { format: options.format } };
    try {
      return { engine: "native", ...(await nativeRenderExport(file, request, onProgress)) };
    } catch (err) {
      if (!(err instanceof NativeUnavailableError)) throw err;
      fallBack(err);
      onProgress(0);
    }
  }
  const blob =
    options.kind === "audio"
      ? await wasm.exportAudio(file, keepRanges, editedDuration, onProgress, {
          format: options.format,
        })
      : await wasm.exportVideo(file, keepRanges, editedDuration, onProgress, {
          withAudio: options.withAudio,
          format: options.format,
          resolution: options.resolution,
        });
  return { engine: "wasm", blob };
}
