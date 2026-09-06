/**
 * Build NLE / DAW timeline interchange files from the editor's keep ranges.
 *
 * XML / FCPXML go through @chatoctopus/timeline writers (imported from dist
 * subpaths to avoid pulling the Node-only ffprobe helper into the browser
 * bundle). AAF is produced by patching a vendored metadata-only scaffold.
 * Reaper `.rpp` and Samplitude `.edl` are written as plain text.
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

export type TimelineExportFormat =
  | "resolve"
  | "premiere"
  | "fcpx"
  | "aaf"
  | "reaper"
  | "samplitude";

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
  /** Formats that need an NLE frame-rate picker (XML / FCPXML / AAF). */
  needsFrameRate: boolean;
}[] = [
  { value: "resolve", label: "Resolve", ext: "xml", needsFrameRate: true },
  { value: "premiere", label: "Premiere", ext: "xml", needsFrameRate: true },
  { value: "fcpx", label: "Final Cut", ext: "fcpxml", needsFrameRate: true },
  { value: "aaf", label: "Pro Tools", ext: "aaf", needsFrameRate: true },
  { value: "reaper", label: "Reaper", ext: "rpp", needsFrameRate: false },
  {
    value: "samplitude",
    label: "Samplitude",
    ext: "edl",
    needsFrameRate: false,
  },
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

/**
 * Drop `modDate` from the exported project.
 *
 * Final Cut Pro rejects the entire document with "DTD validation failed" when
 * it cannot parse this attribute. The upstream writer stamps an IANA zone name
 * (`2026-08-29 12:37:45 America/Los_Angeles`) where FCP wants a numeric UTC
 * offset (`-0700`), and FCP 10.6.x additionally only accepts the clock format
 * matching the user's system 12/24-hour setting. modDate is optional and we
 * have nothing meaningful to put in it, so the safe answer is to omit it.
 *
 * Attribute values are XML-escaped by the writer, so `"` and `>` cannot appear
 * inside one — matching up to the tag's `>` is safe even for odd file names.
 */
export function stripFcpxmlModDate(xml: string): string {
  return xml.replace(/(<project\b[^>]*?)\s+modDate="[^"]*"/g, "$1");
}

export type TimelineXmlFormat = "resolve" | "premiere" | "fcpx";

export function serializeTimelineXml(
  options: TimelineExportOptions,
  format: TimelineXmlFormat
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

  // A single FCP asset-clip carries both the video and the audio of its asset.
  // Our parallel V1/A1 tracks are the same media over the same ranges, so
  // keeping both makes the writer attach A1 as connected clips in lane 1 —
  // FCP imports that as a duplicate video overlay with doubled audio.
  if (timeline.tracks.length > 1) {
    timeline.tracks = timeline.tracks.filter((t) => t.kind === "video");
  }
  return stripFcpxmlModDate(writeFCPXML(timeline));
}

function escapeRppString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function makeGuid(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`.toUpperCase();
}

function reaperSourceKind(fileName: string, withVideo: boolean): string {
  if (withVideo) return "VIDEO";
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "mp3") return "MP3";
  if (ext === "flac") return "FLAC";
  if (ext === "ogg" || ext === "oga") return "VORBIS";
  return "WAVE";
}

/**
 * Build a minimal Reaper project (.rpp) with one track of keep-range items.
 * Media is referenced by filename so the user can relink / place the project
 * next to the source file.
 */
export function serializeReaperRpp(options: TimelineExportOptions): string {
  const { keepRanges, mediaFileName, projectName, withVideo, audioRate = 48000 } =
    options;
  if (keepRanges.length === 0) {
    throw new Error("Everything has been deleted — nothing to export.");
  }

  const name = projectName || mediaFileName.replace(/\.[^.]+$/, "") || "Rescript Edit";
  const sourceKind = reaperSourceKind(mediaFileName, withVideo);
  const trackGuid = makeGuid();
  const lines: string[] = [
    `<REAPER_PROJECT 0.1 "7.0" 0`,
    `  RIPPLE 0`,
    `  AUTOXFADE 1`,
    `  SAMPLERATE ${Math.round(audioRate)} 0 0`,
    `  <NOTES 0 0`,
    `  >`,
    `  <TRACK ${trackGuid}`,
    `    NAME "${escapeRppString(name)}"`,
    `    PEAKCOL 16576`,
    `    BEAT -1`,
    `    AUTOMODE 0`,
    `    VOLPAN 1 0 -1 -1 1`,
    `    MUTESOLO 0 0 0`,
    `    IPHASE 0`,
    `    ISBUS 0 0`,
    `    BUSCOMP 0 0 0 0 0`,
    `    SHOWINMIX 1 0.6667 0.5 1 0.5 0 0 0`,
    `    FREEMODE 0`,
    `    SEL 0`,
    `    REC 0 0 0 0 0 0 0 0`,
    `    TRACKHEIGHT 0 0 0 0 0 0 0`,
    `    INQ 0 0 0 0.5 100 0 0 100`,
    `    NCHAN 2`,
    `    FX 1`,
    `    TRACKID ${trackGuid}`,
    `    PERF 0`,
    `    MIDIOUT -1`,
    `    MAINSEND 1 0`,
  ];

  let timelinePos = 0;
  keepRanges.forEach((range, index) => {
    const length = Math.max(range.end - range.start, 1 / 120);
    const itemGuid = makeGuid();
    const itemName = `${mediaFileName} ${index + 1}`;
    lines.push(
      `    <ITEM`,
      `      POSITION ${timelinePos}`,
      `      SNAPOFFS 0`,
      `      LENGTH ${length}`,
      `      LOOP 0`,
      `      ALLTAKES 0`,
      `      FADEIN 1 0 0 1 0 0 0`,
      `      FADEOUT 1 0 0 1 0 0 0`,
      `      MUTE 0 0`,
      `      SEL 0`,
      `      IGUID ${itemGuid}`,
      `      IID ${index + 1}`,
      `      NAME "${escapeRppString(itemName)}"`,
      `      VOLPAN 1 0 1 -1`,
      `      SOFFS ${range.start}`,
      `      PLAYRATE 1 1 0 -1 0 0.0025`,
      `      CHANMODE 0`,
      `      GUID ${itemGuid}`,
      `      <SOURCE ${sourceKind}`,
      `        FILE "${escapeRppString(mediaFileName)}"`,
      `      >`,
      `    >`
    );
    timelinePos += length;
  });

  lines.push(`  >`, `>`);
  return lines.join("\n") + "\n";
}

function padSample(n: number, width = 12): string {
  return String(Math.max(0, Math.round(n))).padStart(width, " ");
}

/**
 * Build a Samplitude EDL (v1.5) cut list.
 * Reaper can open these directly (File → Open project); times are in samples.
 */
export function serializeSamplitudeEdl(options: TimelineExportOptions): string {
  const { keepRanges, mediaFileName, projectName, audioRate = 48000 } = options;
  if (keepRanges.length === 0) {
    throw new Error("Everything has been deleted — nothing to export.");
  }

  const rate = Math.round(audioRate);
  const title =
    projectName || mediaFileName.replace(/\.[^.]+$/, "") || "Rescript Edit";
  const lines: string[] = [
    `Samplitude EDL File Format Version 1.5`,
    `Title: "${title.replace(/"/g, "'")}"`,
    `Sample Rate: ${rate}`,
    `Output Channels: 2`,
    ``,
    `Source Table Entries: 1`,
    `      1 "${mediaFileName.replace(/"/g, "'")}"`,
    ``,
    `Track 1: "Media" Solo: 0 Mute: 0`,
    `#Source Track Play-In      Play-Out     Record-In    Record-Out   Vol(dB)  MT LK FadeIn       %     CurveType                          FadeOut      %     CurveType                          Name`,
    `#------ ----- ------------ ------------ ------------ ------------ -------- -- -- ------------ ----- ---------------------------------- ------------ ----- ---------------------------------- -----`,
  ];

  let playIn = 0;
  keepRanges.forEach((range, index) => {
    const lengthSec = Math.max(range.end - range.start, 1 / rate);
    const lengthSamples = Math.max(1, Math.round(lengthSec * rate));
    const recordIn = Math.round(range.start * rate);
    const playOut = playIn + lengthSamples;
    const recordOut = recordIn + lengthSamples;
    const clipName = `${mediaFileName} ${index + 1}`.replace(/"/g, "'");
    lines.push(
      [
        padSample(1, 7),
        padSample(1, 5),
        padSample(playIn),
        padSample(playOut),
        padSample(recordIn),
        padSample(recordOut),
        "     0.0  0  0            0     0                         \"*default\"            0     0                         \"*default\"",
        `"${clipName}"`,
      ].join(" ")
    );
    playIn = playOut;
  });

  return lines.join("\n") + "\n";
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

  if (format === "reaper") {
    downloadTimelineBlob(
      serializeReaperRpp(options),
      filename,
      "application/x-reaper-project"
    );
    return;
  }

  if (format === "samplitude") {
    downloadTimelineBlob(
      serializeSamplitudeEdl(options),
      filename,
      "text/plain"
    );
    return;
  }

  const xml = serializeTimelineXml(options, format);
  const mime = format === "fcpx" ? "application/xml" : "text/xml";
  downloadTimelineBlob(xml, filename, mime);
}
