"use client";

import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { en } from "@/lib/i18n/messages/en";
import { hasWasmSimd } from "@/lib/wasmFeatures";
import type { TimeRange } from "./types";

/**
 * Which ffmpeg.wasm core binary to load.
 *
 * - `"mt"` — `@ffmpeg/core-mt`: multi-threaded, fixed 1 GiB shared heap.
 *   Faster, but the heap is committed up front and cannot grow, so 1080p /
 *   original exports reliably OOM (or fail to instantiate under Electron
 *   memory pressure after ASR). Companion to the hang-watchdog in PR #92.
 * - `"st"` — `@ffmpeg/core`: single-threaded, growable 32 MiB → 2 GiB.
 *   Slower encode, but the headroom that high-res export needs.
 */
export type FFmpegCoreKind = "mt" | "st";

const CORE_BASE: Record<FFmpegCoreKind, string> = {
  mt: "/vendor/ffmpeg",
  st: "/vendor/ffmpeg-st",
};

const INPUT_NAME = "input_video";
const MOUNT_DIR = "/mnt_input";

/**
 * Above this, the input is mounted instead of copied into MEMFS.
 *
 * Copying stays the default because it is measurably faster: MEMFS reads are
 * plain memory reads, while a mounted file pays a `Blob.slice` +
 * `FileReaderSync` round trip per avio block (~1.7x slower end to end on a
 * 300 MB file). But it also holds the whole file in memory several times over
 * — the `fetchFile` ArrayBuffer, the structured clone to the worker, and
 * MEMFS's own copy, which is a JS-heap `Uint8Array` rather than wasm memory —
 * and it cannot work at all at 2 GiB (see `mountInput`). A quarter-gig cap
 * keeps the fast path for the sizes it comfortably handles and mounts the rest.
 */
const COPY_INPUT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * How long `exec` may go without any log or progress event before we treat the
 * core as wedged (see {@link execWithWatchdog}).
 *
 * This is a liveness budget, not a time limit: a genuinely slow 4K export runs
 * for hours and resets the timer several times a second the whole way. It only
 * has to clear the longest legitimate silence, which is the final mux —
 * `-movflags +faststart` rewrites the entire output file after the last frame
 * is encoded, and nothing is logged while it does.
 */
const EXEC_STALL_TIMEOUT_MS = 120_000;

/** How long `ffmpeg.load` may take before we treat the core as wedged. */
const LOAD_TIMEOUT_MS = 60_000;

let ffmpegPromise: Promise<FFmpeg> | null = null;
/** Which core `ffmpegPromise` resolved (or is resolving) to. */
let loadedKind: FFmpegCoreKind | null = null;
let writtenFor: File | null = null;
/** Path `writtenFor`'s media is readable at, and whether it came from a mount. */
let inputPath = INPUT_NAME;
let inputMounted = false;

/** Public asset directory for a core kind — exported for tests / copy-assets. */
export function coreAssetBase(kind: FFmpegCoreKind): string {
  return CORE_BASE[kind];
}

/**
 * Core used for video/audio export. Always the growable single-threaded build:
 * the multi-threaded 1 GiB ceiling is what made 1080p/original fail in the
 * desktop app (and hang before the PR #92 watchdog).
 */
export function exportCoreKind(): FFmpegCoreKind {
  return "st";
}

async function loadFFmpegInstance(kind: FFmpegCoreKind): Promise<FFmpeg> {
  const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
  ]);
  // Multi-threaded ffmpeg.wasm needs SharedArrayBuffer, i.e. a
  // cross-origin-isolated page (COOP/COEP from vercel.json on the web, from
  // the app:// handler in Electron). Without it the core throws a bare
  // "SharedArrayBuffer is not defined" from deep inside the worker. The
  // single-threaded core does not need SAB for pthreads, but the rest of the
  // editor (ORT) still does, and UploadScreen already gates on isolation.
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    throw new Error(en["error.mediaEngineNotReady"]);
  }
  // Both cores are SIMD builds, so on an engine without it they fail to
  // compile — as an emscripten abort() wrapping "CompileError: ... Wasm SIMD
  // unsupported", which reaches the caller as an opaque string and ends up
  // shown as the generic "Failed to process this file." Check first so the
  // message names the actual problem. UploadScreen gates on the same check,
  // so this only fires if support changed underneath us.
  if (!hasWasmSimd()) {
    throw new Error(en["error.simdUnsupported"]);
  }
  const base = CORE_BASE[kind];
  const ffmpeg = new FFmpeg();
  const coreURL = await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript");
  const wasmURL = await toBlobURL(
    `${base}/ffmpeg-core.wasm`,
    "application/wasm"
  );
  // Only the multi-threaded build ships a pthread worker.
  const workerURL =
    kind === "mt"
      ? await toBlobURL(`${base}/ffmpeg-core.worker.js`, "text/javascript")
      : undefined;
  // A corrupt / stale cached wasm (common right after an in-app update
  // before the session cache is cleared) makes `load` hang forever, which
  // looked like the app freezing on "add media". Bound it so the user gets
  // an error they can recover from instead of an endless spinner.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(en["error.mediaEngineStalled"]));
    }, LOAD_TIMEOUT_MS);
    ffmpeg
      .load({
        coreURL,
        wasmURL,
        ...(workerURL ? { workerURL } : {}),
        // Served same-origin (copied on postinstall): the bundled class worker
        // contains a dynamic import() that Next's bundler cannot handle.
        classWorkerURL: new URL(
          "/vendor/ffmpeg-class/worker.js",
          location.href
        ).href,
      })
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err);
      });
  });
  return ffmpeg;
}

/**
 * Lazily load a singleton ffmpeg.wasm instance.
 *
 * `kind` selects the core binary. If a different kind is already loaded it is
 * terminated first. Requesting `"mt"` falls back to `"st"` when the fixed 1 GiB
 * shared heap cannot be allocated — the failure mode Discord reported as
 * "ffmpeg not starting" in the desktop app after transcription.
 */
export async function getFFmpeg(kind: FFmpegCoreKind = "mt"): Promise<FFmpeg> {
  // A growable ST instance already satisfies any MT request, and swapping back
  // to MT would re-introduce the 1 GiB allocation that may have just failed.
  if (ffmpegPromise && (loadedKind === kind || loadedKind === "st")) {
    return ffmpegPromise;
  }
  if (ffmpegPromise) {
    await releaseFFmpeg();
  }

  const requested = kind;
  loadedKind = requested;
  ffmpegPromise = (async () => {
    try {
      return await loadFFmpegInstance(requested);
    } catch (err) {
      if (requested !== "mt") throw err;
      // MT instantiate failed (typically can't reserve the 1 GiB SharedArrayBuffer).
      // Hand the half-built worker back and retry with the growable core.
      console.warn(
        "Multi-threaded ffmpeg core failed to load; retrying single-threaded.",
        err
      );
      loadedKind = "st";
      return await loadFFmpegInstance("st");
    }
  })();
  ffmpegPromise.catch(() => {
    ffmpegPromise = null;
    loadedKind = null;
  });
  return ffmpegPromise;
}

/**
 * Terminate the ffmpeg worker and hand its heap back to the browser.
 *
 * The multi-threaded core is built with INITIAL_MEMORY === MAXIMUM_MEMORY ===
 * 1 GiB on a shared WebAssembly.Memory, so the full gigabyte is committed the
 * moment the core instantiates and never shrinks — deleting MEMFS files frees
 * nothing. Held across transcription it sits alongside onnxruntime's heap, the
 * model weights and the decoded PCM, and WebKit kills the tab for it ("This
 * webpage was reloaded because it was using significant memory"). Nothing needs
 * ffmpeg between audio extraction and export, so drop it there and pay one
 * re-init (export then loads the growable single-threaded core).
 */
export async function releaseFFmpeg(): Promise<void> {
  const pending = ffmpegPromise;
  if (!pending) return;
  // Clear first so a concurrent getFFmpeg() builds a fresh instance rather than
  // handing out the one we are about to terminate.
  ffmpegPromise = null;
  loadedKind = null;
  writtenFor = null;
  // The worker owns the filesystem, so its mounts and MEMFS files die with it.
  inputMounted = false;
  inputPath = INPUT_NAME;
  try {
    (await pending).terminate();
  } catch {
    // Load failed or the worker is already gone — the heap went with it.
  }
}

/**
 * Run `ffmpeg.exec` under a liveness watchdog, so a wedged core fails instead
 * of hanging.
 *
 * The multi-threaded core runs the filtergraph and the encoder on real
 * pthreads. When one of those traps — reliably, when the fixed 1 GiB heap runs
 * out — that thread dies and the main ffmpeg thread blocks on a futex it will
 * never be woken from. Nothing reports this: the trap happens in a nested
 * worker, so it never reaches the class worker's `onerror` (patched in, see
 * `patches/README.md`), and the message protocol has no reply for "the core
 * stopped existing". The `exec` promise simply never settles, which is what put
 * export at "Rendering in your browser… 0%" forever.
 *
 * Silence is the signal. The core logs continuously while it is working — the
 * encoder's status line alone lands several times a second — and `postMessage`
 * from the worker still reaches us while its message thread is blocked inside
 * `exec`. So a long enough gap with no log *and* no progress means the work has
 * stopped, whatever killed it.
 *
 * Terminating is the only recovery: it kills the pthreads along with the
 * worker, hands the gigabyte back, and makes the pending `exec` reject so the
 * caller unblocks. The next export builds a fresh core.
 *
 * Exported, and `stallTimeoutMs` overridable, only so `tests/ffmpeg-watchdog-test.ts`
 * can drive it against a stub — there is no way to wedge a real core on demand.
 */
export async function execWithWatchdog(
  ffmpeg: FFmpeg,
  args: string[],
  stallTimeoutMs: number = EXEC_STALL_TIMEOUT_MS
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  const beat = () => {
    if (stalled) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      // Drop the singleton first (that part of releaseFFmpeg is synchronous) so
      // the next export builds a fresh core, then kill this instance by hand:
      // releaseFFmpeg skips the terminate if anything already swapped the
      // singleton out, and skipping it here would leave us hung after all.
      void releaseFFmpeg();
      ffmpeg.terminate();
    }, stallTimeoutMs);
  };
  ffmpeg.on("log", beat);
  ffmpeg.on("progress", beat);
  beat();
  try {
    return await ffmpeg.exec(args);
  } catch (err) {
    // The rejection we get here is `terminate()`'s, which describes our own
    // recovery rather than what went wrong. Say what the user saw instead.
    if (stalled) throw new Error(en["error.mediaEngineStalled"]);
    throw err;
  } finally {
    clearTimeout(timer);
    ffmpeg.off("log", beat);
    ffmpeg.off("progress", beat);
  }
}

/**
 * Expose `file` to ffmpeg via WORKERFS rather than copying it in.
 *
 * WORKERFS serves reads straight off the `Blob` — one `slice` plus a
 * `FileReaderSync` per avio block — so the media is never materialised as a
 * single ArrayBuffer. That is what makes multi-gigabyte imports possible at
 * all: a `Uint8Array` cannot exceed 2 GiB in Chrome, so `fetchFile`'s
 * `FileReader.readAsArrayBuffer` fails outright at exactly that size (measured:
 * 2040 MiB reads, 2048 MiB does not). It surfaces as the opaque "File could not
 * be read! Code=-1" from `@ffmpeg/util`, because a modern DOMException has no
 * legacy `.code` for the template to interpolate.
 *
 * Mounted as a named blob so the path we hand ffmpeg is always `input_video`,
 * whatever the user called their file. Read-only, which is all input needs.
 */
async function mountInput(ffmpeg: FFmpeg, file: File): Promise<string> {
  const { FFFSType } = await import("@ffmpeg/ffmpeg");
  try {
    await ffmpeg.createDir(MOUNT_DIR);
  } catch {
    // Already there from a previous file; the unmount in clearInput left it.
  }
  await ffmpeg.mount(
    FFFSType.WORKERFS,
    { blobs: [{ name: INPUT_NAME, data: file }] },
    MOUNT_DIR
  );
  inputMounted = true;
  return `${MOUNT_DIR}/${INPUT_NAME}`;
}

/** Release the previous input so a second file doesn't stack onto the first. */
async function clearInput(ffmpeg: FFmpeg): Promise<void> {
  if (!writtenFor) return;
  const wasMounted = inputMounted;
  writtenFor = null;
  inputMounted = false;
  try {
    if (wasMounted) await ffmpeg.unmount(MOUNT_DIR);
    else await ffmpeg.deleteFile(INPUT_NAME);
  } catch {
    // Nothing there to reclaim — mounting/writing the next input still works.
  }
}

async function ensureInput(ffmpeg: FFmpeg, file: File): Promise<string> {
  if (writtenFor === file) return inputPath;
  await clearInput(ffmpeg);

  if (file.size > COPY_INPUT_MAX_BYTES) {
    try {
      inputPath = await mountInput(ffmpeg, file);
      writtenFor = file;
      return inputPath;
    } catch (err) {
      // No WORKERFS in this core, or the mount was rejected. Copying will
      // probably fail too at this size, but it fails with ffmpeg's own error
      // rather than ours, so let it try.
      console.warn("WORKERFS mount failed, copying input instead:", err);
      inputMounted = false;
    }
  }

  const { fetchFile } = await import("@ffmpeg/util");
  await ffmpeg.writeFile(INPUT_NAME, await fetchFile(file));
  writtenFor = file;
  inputPath = INPUT_NAME;
  return inputPath;
}

/**
 * Extract the audio track as mono 16 kHz float PCM — the exact format
 * Whisper expects, and what we render the timeline waveform from.
 * Works for both video and audio-only files. Resolves to null when the file
 * has no audio track — those still open for editing with an empty transcript.
 */
export async function extractAudio(file: File): Promise<Float32Array | null> {
  // Prefer the multi-threaded core for decode speed; getFFmpeg falls back to
  // the growable single-threaded build if the 1 GiB shared heap won't allocate.
  const ffmpeg = await getFFmpeg("mt");
  const input = await ensureInput(ffmpeg, file);
  const out = "audio.pcm";
  let sawAudioStream = false;
  const logHandler = ({ message }: { type: string; message: string }) => {
    if (/Stream #\d+:\d+.*: Audio:/.test(message)) sawAudioStream = true;
  };
  ffmpeg.on("log", logHandler);
  let code: number;
  try {
    code = await execWithWatchdog(ffmpeg, [
      "-i", input,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-f", "f32le",
      "-y", out,
    ]);
  } finally {
    ffmpeg.off("log", logHandler);
  }
  if (code !== 0) {
    if (!sawAudioStream) return null;
    throw new Error(en["error.extractAudio"]);
  }
  const data = (await ffmpeg.readFile(out)) as Uint8Array;
  await ffmpeg.deleteFile(out);
  if (data.byteLength < 4) return null;
  // Copy into a fresh buffer so byteOffset/alignment is clean.
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return new Float32Array(buf as ArrayBuffer);
}

/** Container / codec presets for video export. */
export type VideoExportFormat = "mp4" | "webm";

/** Target output height. `"original"` keeps the source resolution. */
export type VideoExportResolution = "original" | "720" | "1080" | "2160";

/** Container / codec presets for audio-only export. */
export type AudioExportFormat = "m4a" | "mp3" | "wav";

export interface VideoExportOptions {
  /** When false, render a silent video (source has no audio track). */
  withAudio?: boolean;
  format?: VideoExportFormat;
  resolution?: VideoExportResolution;
}

export interface AudioExportOptions {
  format?: AudioExportFormat;
}

const VIDEO_HEIGHT: Record<Exclude<VideoExportResolution, "original">, number> = {
  "720": 720,
  "1080": 1080,
  "2160": 2160,
};

/**
 * Scale filter that fits inside the target height without upscaling, keeping
 * even dimensions (required by libx264 / libvpx).
 */
function scaleFilter(resolution: VideoExportResolution): string | null {
  if (resolution === "original") return null;
  const h = VIDEO_HEIGHT[resolution];
  // Never upscale: cap height at source ih. force_original_aspect_ratio keeps
  // width proportional; the second scale snaps to even sizes.
  return `scale=-2:'min(ih,${h})',scale=trunc(iw/2)*2:trunc(ih/2)*2`;
}

/**
 * Render the edited video: keep only `keepRanges` of the original media and
 * concatenate them. Re-encodes so cuts land exactly on word boundaries
 * rather than keyframes. `withAudio: false` renders a silent source, whose
 * missing [0:a] would otherwise fail the whole filtergraph.
 */
export async function exportVideo(
  file: File,
  keepRanges: TimeRange[],
  editedDuration: number,
  onProgress: (ratio: number) => void,
  {
    withAudio = true,
    format = "mp4",
    resolution = "original",
  }: VideoExportOptions = {}
): Promise<Blob> {
  if (keepRanges.length === 0) {
    throw new Error(en["error.nothingToExport"]);
  }
  // Growable heap: the MT core's fixed 1 GiB is what failed 1080p/original
  // exports (Discord: "ffmpeg not starting" in the desktop app; browser OK).
  const ffmpeg = await getFFmpeg(exportCoreKind());
  const input = await ensureInput(ffmpeg, file);
  const out = format === "webm" ? "output.webm" : "output.mp4";
  const scale = scaleFilter(resolution);

  const parts: string[] = [];
  const labels: string[] = [];
  keepRanges.forEach((r, i) => {
    const s = r.start.toFixed(3);
    const e = r.end.toFixed(3);
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    labels.push(`[v${i}]`);
    if (withAudio) {
      parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
      labels[labels.length - 1] += `[a${i}]`;
    }
  });
  let filter =
    parts.join(";") +
    `;${labels.join("")}concat=n=${keepRanges.length}:v=1:a=${
      withAudio ? 1 : 0
    }[outv]${withAudio ? "[outa]" : ""}`;
  const videoMap = scale ? "[vout]" : "[outv]";
  if (scale) {
    filter += `;[outv]${scale}[vout]`;
  }

  const progressHandler = ({ time }: { progress: number; time: number }) => {
    // `time` is the output timestamp in microseconds.
    const ratio = Math.min(1, time / 1e6 / Math.max(0.001, editedDuration));
    onProgress(Math.max(0, ratio));
  };
  ffmpeg.on("progress", progressHandler);
  try {
    const codecArgs =
      format === "webm"
        ? [
            "-c:v", "libvpx-vp9",
            "-crf", "35",
            "-b:v", "0",
            "-row-mt", "1",
            "-cpu-used", "8",
            ...(withAudio ? ["-c:a", "libopus", "-b:a", "128k"] : []),
          ]
        : [
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "22",
            ...(withAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
            "-movflags", "+faststart",
          ];

    const code = await execWithWatchdog(ffmpeg, [
      "-i", input,
      "-filter_complex", filter,
      "-map", videoMap,
      ...(withAudio ? ["-map", "[outa]"] : ["-an"]),
      ...codecArgs,
      "-y", out,
    ]);
    if (code !== 0) throw new Error(en["error.videoExport"]);
    const data = (await ffmpeg.readFile(out)) as Uint8Array;
    await ffmpeg.deleteFile(out);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return new Blob([buf as ArrayBuffer], {
      type: format === "webm" ? "video/webm" : "video/mp4",
    });
  } finally {
    ffmpeg.off("progress", progressHandler);
  }
}

/**
 * Render an edited audio-only file: keep only `keepRanges` and concatenate
 * them. Works for both audio projects and the audio track of a video file.
 */
export async function exportAudio(
  file: File,
  keepRanges: TimeRange[],
  editedDuration: number,
  onProgress: (ratio: number) => void,
  { format = "m4a" }: AudioExportOptions = {}
): Promise<Blob> {
  if (keepRanges.length === 0) {
    throw new Error(en["error.nothingToExport"]);
  }
  const ffmpeg = await getFFmpeg(exportCoreKind());
  const input = await ensureInput(ffmpeg, file);
  const out =
    format === "mp3" ? "output.mp3" : format === "wav" ? "output.wav" : "output.m4a";

  const parts: string[] = [];
  const labels: string[] = [];
  keepRanges.forEach((r, i) => {
    const s = r.start.toFixed(3);
    const e = r.end.toFixed(3);
    parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[a${i}]`);
  });
  const filter =
    parts.join(";") +
    `;${labels.join("")}concat=n=${keepRanges.length}:v=0:a=1[outa]`;

  const progressHandler = ({ time }: { progress: number; time: number }) => {
    const ratio = Math.min(1, time / 1e6 / Math.max(0.001, editedDuration));
    onProgress(Math.max(0, ratio));
  };
  ffmpeg.on("progress", progressHandler);
  try {
    const codecArgs =
      format === "mp3"
        ? ["-c:a", "libmp3lame", "-b:a", "192k"]
        : format === "wav"
          ? ["-c:a", "pcm_s16le"]
          : ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];

    const code = await execWithWatchdog(ffmpeg, [
      "-i", input,
      "-filter_complex", filter,
      "-map", "[outa]",
      ...codecArgs,
      "-y", out,
    ]);
    if (code !== 0) throw new Error(en["error.audioExport"]);
    const data = (await ffmpeg.readFile(out)) as Uint8Array;
    await ffmpeg.deleteFile(out);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const mime =
      format === "mp3"
        ? "audio/mpeg"
        : format === "wav"
          ? "audio/wav"
          : "audio/mp4";
    return new Blob([buf as ArrayBuffer], { type: mime });
  } finally {
    ffmpeg.off("progress", progressHandler);
  }
}
