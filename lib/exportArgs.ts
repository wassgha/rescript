/**
 * ffmpeg argument building shared by both media engines: ffmpeg.wasm in the
 * renderer (`lib/ffmpeg.ts`) and the bundled native binary the desktop app runs
 * from its main process (`electron/media.ts`).
 *
 * Kept free of imports (not even ./types, which pulls in browser-only modules)
 * so the Electron bundle can compile it unchanged — the main process builds its
 * own argv from a validated request rather than running whatever the renderer
 * sends.
 */

/** Same shape as `TimeRange` in ./types: [start, end) in original media seconds. */
export interface TimeRange {
  start: number;
  end: number;
}

/** Container / codec presets for video export. */
export type VideoExportFormat = "mp4" | "webm";

/**
 * Target size, as the length of the frame's short side — so "1080" is
 * 1920×1080 for landscape and 1080×1920 for a vertical phone video.
 * `"original"` keeps the source resolution. Never upscales.
 */
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

/** H.264 encoders an MP4 export can use. */
export type H264Encoder = "libx264" | "h264_videotoolbox";

/** Engine-specific encoder tuning. */
export interface EncoderTuning {
  /**
   * libx264 preset. The wasm core is single-threaded and memory-bound, so it
   * keeps `ultrafast`; a native encoder can afford a smaller file.
   */
  x264Preset?: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium";
  /**
   * MP4 video encoder. `h264_videotoolbox` is the Mac's hardware encoder: as
   * fast as libx264 on an 8-core M1 Pro, 1.5–2.2× faster on 4-core machines,
   * and it leaves the CPU free. Only the desktop app's native engine uses it.
   */
  h264Encoder?: H264Encoder;
}

/**
 * VideoToolbox constant-quality level matched to libx264 `-crf 22`: on a
 * 16 Mb/s 1080p source both land at ~32 MB / 30 s with SSIM 0.982. Constant
 * quality needs Apple Silicon; Intel Macs fail the probe and use libx264.
 */
export const VIDEOTOOLBOX_QUALITY = 65;

/** Everything about an export except where its input and output live. */
export interface ExportPlan {
  /** `-filter_complex` graph. */
  filter: string;
  /** `-map` / `-an` arguments selecting the graph's outputs. */
  streamArgs: string[];
  codecArgs: string[];
  /** Output file extension, without the dot. */
  ext: string;
  mime: string;
}

export const VIDEO_FORMATS: readonly VideoExportFormat[] = ["mp4", "webm"];
export const VIDEO_RESOLUTIONS: readonly VideoExportResolution[] = [
  "original",
  "720",
  "1080",
  "2160",
];
export const AUDIO_FORMATS: readonly AudioExportFormat[] = ["m4a", "mp3", "wav"];

const SHORT_SIDE: Record<Exclude<VideoExportResolution, "original">, number> = {
  "720": 720,
  "1080": 1080,
  "2160": 2160,
};

/** Matches the stream line ffmpeg logs for an input audio track. */
export const AUDIO_STREAM_RE = /Stream #\d+:\d+.*: Audio:/;

/**
 * Scale filter that brings the frame's short side down to the target, keeping
 * the aspect ratio and even dimensions (required by libx264 / libvpx). Sources
 * already at or below the target pass through unscaled.
 *
 * Capping the short side rather than the height is what keeps "1080p" of a
 * vertical 2160×3840 phone video at 1080×1920 instead of 608×1080. Plain
 * arithmetic (no `-2` sentinels inside expressions), so the wasm core's
 * ffmpeg 5.1 evaluates it exactly like the native 6.x–7.x builds.
 */
export function scaleFilter(resolution: VideoExportResolution): string | null {
  if (resolution === "original") return null;
  const k = `min(1,${SHORT_SIDE[resolution]}/min(iw,ih))`;
  return `scale=w='trunc(iw*${k}/2)*2':h='trunc(ih*${k}/2)*2'`;
}

/**
 * Resolution an export starts at: 1080p for anything larger, the source size
 * otherwise. Most exports end up on screens and social feeds where 4K buys
 * nothing, and rendering 4K is 4× the pixels — about 3.7× slower in practice.
 * Unknown dimensions (0×0) default to 1080p, which never upscales anyway.
 */
export function defaultExportResolution(
  width: number,
  height: number
): VideoExportResolution {
  const shortSide = Math.min(width, height);
  return shortSide > 0 && shortSide <= SHORT_SIDE["1080"] ? "original" : "1080";
}

/**
 * Keep only `keepRanges` of the original media and concatenate them.
 * Re-encodes so cuts land exactly on word boundaries rather than keyframes.
 * `withAudio: false` renders a silent source, whose missing [0:a] would
 * otherwise fail the whole filtergraph.
 */
export function buildVideoExport(
  keepRanges: TimeRange[],
  { withAudio = true, format = "mp4", resolution = "original" }: VideoExportOptions = {},
  { x264Preset = "ultrafast", h264Encoder = "libx264" }: EncoderTuning = {}
): ExportPlan {
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

  // yuv420p: a 10-bit or 4:2:2 source (HEVC from a phone, ProRes) otherwise
  // carries its pixel format through, and High10 / 4:2:2 H.264 or VP9 profile 2
  // doesn't play in QuickTime or most browsers.
  const codecArgs =
    format === "webm"
      ? [
          "-c:v", "libvpx-vp9",
          "-crf", "35",
          "-b:v", "0",
          "-row-mt", "1",
          "-cpu-used", "8",
          "-pix_fmt", "yuv420p",
          ...(withAudio ? ["-c:a", "libopus", "-b:a", "128k"] : []),
        ]
      : [
          ...(h264Encoder === "h264_videotoolbox"
            ? ["-c:v", "h264_videotoolbox", "-q:v", String(VIDEOTOOLBOX_QUALITY)]
            : ["-c:v", "libx264", "-preset", x264Preset, "-crf", "22"]),
          "-pix_fmt", "yuv420p",
          ...(withAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
          "-movflags", "+faststart",
        ];

  return {
    filter,
    streamArgs: ["-map", videoMap, ...(withAudio ? ["-map", "[outa]"] : ["-an"])],
    codecArgs,
    ext: format === "webm" ? "webm" : "mp4",
    mime: format === "webm" ? "video/webm" : "video/mp4",
  };
}

/**
 * Keep only `keepRanges` of the audio track and concatenate them. Works for
 * both audio projects and the audio track of a video file.
 */
export function buildAudioExport(
  keepRanges: TimeRange[],
  { format = "m4a" }: AudioExportOptions = {}
): ExportPlan {
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

  const codecArgs =
    format === "mp3"
      ? ["-c:a", "libmp3lame", "-b:a", "192k"]
      : format === "wav"
        ? ["-c:a", "pcm_s16le"]
        : ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];

  return {
    filter,
    streamArgs: ["-map", "[outa]"],
    codecArgs,
    ext: format,
    mime:
      format === "mp3" ? "audio/mpeg" : format === "wav" ? "audio/wav" : "audio/mp4",
  };
}

/** Mono 16 kHz float PCM — what Whisper expects and the waveform is drawn from. */
export function extractAudioArgs(input: string, out: string): string[] {
  return ["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-y", out];
}

/** A media export the desktop main process is asked to render. */
export type ExportRequest =
  | {
      kind: "video";
      keepRanges: TimeRange[];
      editedDuration: number;
      options: Required<VideoExportOptions>;
    }
  | {
      kind: "audio";
      keepRanges: TimeRange[];
      editedDuration: number;
      options: Required<AudioExportOptions>;
    };

/**
 * More ranges than anyone produces by hand, and still far below what the
 * filtergraph (one trim branch per range) can be asked to parse.
 */
export const MAX_EXPORT_RANGES = 20_000;

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Validate an export request that crossed a process boundary. Returns null for
 * anything malformed, so the main process never builds a filtergraph out of
 * values it hasn't checked.
 */
export function parseExportRequest(value: unknown): ExportRequest | null {
  if (!value || typeof value !== "object") return null;
  const { kind, keepRanges, editedDuration, options } = value as Record<
    string,
    unknown
  >;
  if (kind !== "video" && kind !== "audio") return null;
  if (!isFiniteNonNegative(editedDuration)) return null;
  if (!Array.isArray(keepRanges)) return null;
  if (keepRanges.length === 0 || keepRanges.length > MAX_EXPORT_RANGES) return null;
  const ranges: TimeRange[] = [];
  let previousEnd = 0;
  for (const range of keepRanges) {
    if (!range || typeof range !== "object") return null;
    const { start, end } = range as Record<string, unknown>;
    if (!isFiniteNonNegative(start) || !isFiniteNonNegative(end)) return null;
    if (end <= start || start < previousEnd) return null;
    previousEnd = end;
    ranges.push({ start, end });
  }
  if (!options || typeof options !== "object") return null;
  const opts = options as Record<string, unknown>;
  if (kind === "video") {
    const { withAudio, format, resolution } = opts;
    if (typeof withAudio !== "boolean") return null;
    if (!VIDEO_FORMATS.includes(format as VideoExportFormat)) return null;
    if (!VIDEO_RESOLUTIONS.includes(resolution as VideoExportResolution)) return null;
    return {
      kind,
      keepRanges: ranges,
      editedDuration,
      options: {
        withAudio,
        format: format as VideoExportFormat,
        resolution: resolution as VideoExportResolution,
      },
    };
  }
  if (!AUDIO_FORMATS.includes(opts.format as AudioExportFormat)) return null;
  return {
    kind,
    keepRanges: ranges,
    editedDuration,
    options: { format: opts.format as AudioExportFormat },
  };
}

/**
 * Incremental parser for `-progress pipe:1` output: `key=value` lines, one
 * block per update, each closed by `progress=continue` (or `progress=end` once
 * the encode is done). Calls `onTime` with the output timestamp in seconds.
 *
 * `out_time_us` reads `N/A` before the first frame and can be negative while
 * the muxer settles its start time; both are ignored rather than reported as 0.
 */
export function createProgressParser(
  onTime: (seconds: number) => void,
  onEnd?: () => void
): (chunk: string) => void {
  let pending = "";
  return (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === "out_time_us" || key === "out_time_ms") {
        // Despite the name, out_time_ms is also microseconds (an old ffmpeg
        // bug kept for compatibility); prefer _us but accept either.
        const us = Number(value);
        if (Number.isFinite(us) && us >= 0) onTime(us / 1e6);
      } else if (key === "progress" && value === "end") {
        onEnd?.();
      }
    }
  };
}

/** Progress ratio for an output timestamp, clamped to [0, 1]. */
export function progressRatio(seconds: number, editedDuration: number): number {
  return Math.max(0, Math.min(1, seconds / Math.max(0.001, editedDuration)));
}
