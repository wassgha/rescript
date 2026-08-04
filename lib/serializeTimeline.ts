/**
 * Build NLE timeline interchange files from the editor's keep ranges.
 *
 * XML / FCPXML go through @chatoctopus/timeline writers (imported from dist
 * subpaths to avoid pulling the Node-only ffprobe helper into the browser
 * bundle). AAF is produced by patching a vendored metadata-only scaffold.
 */

import { writeFCPXML } from "../node_modules/@chatoctopus/timeline/dist/fcpxml/writer.js";
import { writeXMEML } from "../node_modules/@chatoctopus/timeline/dist/xmeml/writer.js";
import {
  FRAME_RATES,
  rational,
  ZERO,
} from "../node_modules/@chatoctopus/timeline/dist/time.js";
import type { Timeline } from "@chatoctopus/timeline";
import {
  writeAafComposition,
  type AafFrameRate,
} from "@/lib/aaf/patchAaf";
import type { TimeRange } from "@/lib/types";

export type TimelineExportFormat = "resolve" | "premiere" | "fcpx" | "aaf";

export type TimelineFrameRate = AafFrameRate;

export const TIMELINE_FRAME_RATES: {
  value: TimelineFrameRate;
  label: string;
}[] = [
  { value: "23.976", label: "23.976" },
  { value: "24", label: "24" },
  { value: "25", label: "25" },
  { value: "29.97", label: "29.97" },
  { value: "30", label: "30" },
  { value: "50", label: "50" },
  { value: "59.94", label: "59.94" },
  { value: "60", label: "60" },
];

export const TIMELINE_FORMATS: {
  value: TimelineExportFormat;
  label: string;
  ext: string;
}[] = [
  { value: "resolve", label: "Resolve", ext: "xml" },
  { value: "premiere", label: "Premiere", ext: "xml" },
  { value: "fcpx", label: "Final Cut", ext: "fcpxml" },
  { value: "aaf", label: "Pro Tools", ext: "aaf" },
];

export interface TimelineExportOptions {
  keepRanges: TimeRange[];
  duration: number;
  mediaFileName: string;
  projectName?: string;
  frameRate: TimelineFrameRate;
  /** false for audio-only projects */
  withVideo: boolean;
  withAudio: boolean;
  width?: number;
  height?: number;
  audioRate?: number;
}

function frameRateRational(frameRate: TimelineFrameRate) {
  return FRAME_RATES[frameRate] ?? FRAME_RATES["30"];
}

function secondsToRational(seconds: number, frameRate: TimelineFrameRate) {
  const fr = frameRateRational(frameRate);
  const frames = Math.max(0, Math.round(seconds * (fr.num / fr.den)));
  return rational(frames * fr.den, fr.num);
}

/** file:// URL that NLEs can attempt to resolve; users usually relink by name. */
export function mediaFileUrl(fileName: string, forResolve = false): string {
  const encoded = fileName
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  return forResolve
    ? `file://localhost/${encoded}`
    : `file:///${encoded}`;
}

export function buildNleTimeline(options: TimelineExportOptions): Timeline {
  const {
    keepRanges,
    duration,
    mediaFileName,
    projectName,
    frameRate,
    withVideo,
    withAudio,
    width = 1920,
    height = 1080,
    audioRate = 48000,
  } = options;

  if (keepRanges.length === 0) {
    throw new Error("Everything has been deleted — nothing to export.");
  }

  const fr = frameRateRational(frameRate);
  const available = {
    startTime: ZERO,
    duration: secondsToRational(Math.max(duration, 0.001), frameRate),
  };

  const makeClip = (range: TimeRange, index: number, kind: "video" | "audio") => {
    const startTime = secondsToRational(range.start, frameRate);
    const clipDur = secondsToRational(
      Math.max(range.end - range.start, 1 / 120),
      frameRate
    );
    return {
      kind: "clip" as const,
      name: `${mediaFileName} ${index + 1}`,
      mediaReference: {
        type: "external" as const,
        name: mediaFileName,
        targetUrl: mediaFileUrl(mediaFileName, false),
        mediaKind: kind === "video" ? ("video" as const) : ("audio" as const),
        availableRange: available,
        streamInfo: {
          hasVideo: withVideo,
          hasAudio: withAudio,
          width,
          height,
          frameRate: fr,
          audioRate,
          audioChannels: withAudio ? 2 : 0,
        },
      },
      sourceRange: { startTime, duration: clipDur },
    };
  };

  const tracks: Timeline["tracks"] = [];
  if (withVideo) {
    tracks.push({
      kind: "video",
      name: "V1",
      items: keepRanges.map((r, i) => makeClip(r, i, "video")),
    });
  }
  if (withAudio) {
    tracks.push({
      kind: "audio",
      name: "A1",
      items: keepRanges.map((r, i) => makeClip(r, i, "audio")),
    });
  }
  if (tracks.length === 0) {
    throw new Error("Nothing to put on the timeline.");
  }

  return {
    name: projectName || mediaFileName.replace(/\.[^.]+$/, "") || "Rescript Edit",
    format: {
      width,
      height,
      frameRate: fr,
      audioRate,
      audioChannels: withAudio ? 2 : 0,
      audioLayout: "stereo",
      colorSpace: "1-1-1 (Rec. 709)",
    },
    tracks,
  };
}

export function timelineExtension(format: TimelineExportFormat): string {
  return TIMELINE_FORMATS.find((f) => f.value === format)?.ext ?? format;
}

export function serializeTimelineXml(
  options: TimelineExportOptions,
  format: Exclude<TimelineExportFormat, "aaf">
): string {
  const timeline = buildNleTimeline(options);
  if (format === "resolve") {
    for (const track of timeline.tracks) {
      for (const item of track.items) {
        if (item.kind !== "clip") continue;
        const ref = item.mediaReference;
        if (ref.type === "external") {
          ref.targetUrl = mediaFileUrl(ref.name || options.mediaFileName, true);
        }
      }
    }
    return writeXMEML(timeline);
  }
  if (format === "premiere") return writeXMEML(timeline);
  return writeFCPXML(timeline);
}

export async function serializeTimelineAaf(
  options: TimelineExportOptions
): Promise<Blob> {
  return writeAafComposition({
    keepRanges: options.keepRanges,
    duration: options.duration,
    mediaFileName: options.mediaFileName,
    frameRate: options.frameRate,
    withVideo: options.withVideo,
    withAudio: options.withAudio,
  });
}

/** Trigger a browser download for an XML/FCPXML string or AAF blob. */
export function downloadTimelineBlob(
  data: string | Blob,
  filename: string,
  mime: string
): void {
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: `${mime};charset=utf-8` })
      : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadTimelineExport(
  format: TimelineExportFormat,
  options: TimelineExportOptions
): Promise<void> {
  const base = (options.projectName || options.mediaFileName || "edited").replace(
    /\.[^.]+$/,
    ""
  );
  const ext = timelineExtension(format);
  const filename = `${base}.edited.${ext}`;

  if (format === "aaf") {
    const blob = await serializeTimelineAaf(options);
    downloadTimelineBlob(blob, filename, "application/octet-stream");
    return;
  }

  const xml = serializeTimelineXml(options, format);
  const mime = format === "fcpx" ? "application/xml" : "text/xml";
  downloadTimelineBlob(xml, filename, mime);
}
