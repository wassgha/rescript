/**
 * Patch the vendored AAF scaffold into a composition for the current edit.
 *
 * The scaffold (public/vendor/aaf/scaffold.aaf) is a TopLevel CompositionMob
 * with 64 pre-allocated Picture + Sound SourceClips. We rewrite clip
 * start/length, truncate the component index to the keep-range count, swap the
 * media URL/name (fixed-width UTF-16), and optionally retarget the edit rate.
 */

import * as CFB from "cfb";
import type { TimeRange } from "../types";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const SCAFFOLD_URL = `${BASE_PATH}/vendor/aaf/scaffold.aaf`;

/** Must match scripts/generate-aaf-scaffold.py */
export const AAF_MAX_CLIPS = 64;
const MARKER_NAME = "RESCRIPT_MEDIA_PLACEHOLDER"; // 26 chars — keep in sync with scaffold
const SCAFFOLD_EDIT_RATE = 30;

export type AafFrameRate =
  | "23.976"
  | "24"
  | "25"
  | "29.97"
  | "30"
  | "50"
  | "59.94"
  | "60";

const FRAME_RATE_RATIONAL: Record<AafFrameRate, { num: number; den: number }> = {
  "23.976": { num: 24000, den: 1001 },
  "24": { num: 24, den: 1 },
  "25": { num: 25, den: 1 },
  "29.97": { num: 30000, den: 1001 },
  "30": { num: 30, den: 1 },
  "50": { num: 50, den: 1 },
  "59.94": { num: 60000, den: 1001 },
  "60": { num: 60, den: 1 },
};

export interface AafExportInput {
  keepRanges: TimeRange[];
  /** Original media duration in seconds (for source length). */
  duration: number;
  mediaFileName: string;
  frameRate: AafFrameRate;
  /** Include a picture track (false for audio-only projects). */
  withVideo: boolean;
  /** Include a sound track. */
  withAudio: boolean;
}

let scaffoldPromise: Promise<ArrayBuffer> | null = null;

async function loadScaffold(): Promise<ArrayBuffer> {
  if (!scaffoldPromise) {
    scaffoldPromise = fetch(SCAFFOLD_URL)
      .then((r) => {
        if (!r.ok) throw new Error("Could not load the AAF export template.");
        return r.arrayBuffer();
      })
      .catch((err) => {
        scaffoldPromise = null;
        throw err;
      });
  }
  return scaffoldPromise;
}

/** Encode a JS string as UTF-16LE without BOM. */
function utf16le(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

/**
 * Pad / truncate to the scaffold placeholder width so we can patch in place.
 * When truncating, keep the file extension so NLE relink-by-name still works.
 */
export function fitAafMediaName(fileName: string): string {
  const base = fileName || "media";
  const width = MARKER_NAME.length;
  if (base.length === width) return base;
  if (base.length < width) return base.padEnd(width, " ");

  const lastDot = base.lastIndexOf(".");
  const ext = lastDot > 0 ? base.slice(lastDot) : "";
  const stem = lastDot > 0 ? base.slice(0, lastDot) : base;
  if (!ext || ext.length >= width) return base.slice(0, width);
  return (stem.slice(0, width - ext.length) + ext).padEnd(width, " ");
}

/** file:// URL for AAF NetworkLocator (percent-encoded; variable-length rewrite). */
export function aafMediaFileUrl(fileName: string): string {
  const encoded = (fileName || "media")
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  return `file:///${encoded}`;
}

export function secondsToFrames(seconds: number, frameRate: AafFrameRate): number {
  const { num, den } = FRAME_RATE_RATIONAL[frameRate];
  return Math.max(0, Math.round((seconds * num) / den));
}

function replaceUtf16InPlace(buf: Uint8Array, from: string, to: string): number {
  if (from.length !== to.length) {
    throw new Error("AAF in-place replace requires equal-length strings.");
  }
  const needle = utf16le(from);
  const replacement = utf16le(to);
  let hits = 0;
  outer: for (let i = 0; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    buf.set(replacement, i);
    hits++;
    i += needle.length - 1;
  }
  return hits;
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

function writeI64LE(buf: Uint8Array, offset: number, value: number): void {
  const lo = value >>> 0;
  const hi = Math.floor(value / 0x1_0000_0000);
  writeU32LE(buf, offset, lo);
  writeU32LE(buf, offset + 4, hi);
}

function writeI32LE(buf: Uint8Array, offset: number, value: number): void {
  writeU32LE(buf, offset, value >>> 0);
}

/** Parse an AAF `properties` stream and return byte offsets of SF_DATA payloads by pid. */
function dataOffsetsByPid(props: Uint8Array): Map<number, number> {
  if (props.length < 4 || props[0] !== 0x4c) {
    throw new Error("Invalid AAF property stream.");
  }
  const entryCount = props[2] | (props[3] << 8);
  const map = new Map<number, number>();
  let header = 4;
  let data = 4 + entryCount * 6;
  for (let i = 0; i < entryCount; i++) {
    const pid = props[header] | (props[header + 1] << 8);
    const size = props[header + 4] | (props[header + 5] << 8);
    map.set(pid, data);
    header += 6;
    data += size;
  }
  return map;
}

function patchClipProperties(
  props: Uint8Array,
  startFrames: number,
  lengthFrames: number
): void {
  const offsets = dataOffsetsByPid(props);
  const lengthOff = offsets.get(0x0202); // Length
  const startOff = offsets.get(0x1201); // StartTime
  if (lengthOff == null || startOff == null) {
    throw new Error("SourceClip is missing Length/StartTime.");
  }
  writeI64LE(props, lengthOff, lengthFrames);
  writeI64LE(props, startOff, startFrames);
}

function writeComponentsIndex(count: number, maxClips: number): Uint8Array {
  const buf = new Uint8Array(12 + count * 4);
  writeU32LE(buf, 0, count);
  writeU32LE(buf, 4, maxClips);
  writeU32LE(buf, 8, 0xffffffff);
  for (let i = 0; i < count; i++) writeU32LE(buf, 12 + i * 4, i);
  return buf;
}

function patchEditRate(slotProps: Uint8Array, num: number, den: number): void {
  const oldNum = SCAFFOLD_EDIT_RATE;
  const oldDen = 1;
  for (let i = 0; i <= slotProps.length - 8; i++) {
    const n =
      slotProps[i] |
      (slotProps[i + 1] << 8) |
      (slotProps[i + 2] << 16) |
      (slotProps[i + 3] << 24);
    const d =
      slotProps[i + 4] |
      (slotProps[i + 5] << 8) |
      (slotProps[i + 6] << 16) |
      (slotProps[i + 7] << 24);
    if (n === oldNum && d === oldDen) {
      writeI32LE(slotProps, i, num);
      writeI32LE(slotProps, i + 4, den);
      return;
    }
  }
  throw new Error(
    `AAF scaffold edit rate ${oldNum}/${oldDen} not found; cannot retarget to ${num}/${den}.`
  );
}

function writeLocatorProperties(url: string): Uint8Array {
  const data = utf16le(url);
  // property header: byte_order, version, entry_count=1
  // entry: pid=0x4001 (URLString), format=0x82 (SF_DATA), size
  const out = new Uint8Array(4 + 6 + data.length);
  out[0] = 0x4c;
  out[1] = 0x20; // PROPERTY_VERSION
  out[2] = 1;
  out[3] = 0; // entry_count = 1
  out[4] = 0x01;
  out[5] = 0x40; // pid 0x4001
  out[6] = 0x82;
  out[7] = 0x00; // SF_DATA
  out[8] = data.length & 0xff;
  out[9] = (data.length >> 8) & 0xff;
  out.set(data, 10);
  return out;
}

function ensureContent(content: CFB.CFB$Blob | undefined | null): Uint8Array {
  if (content == null) return new Uint8Array();
  return content instanceof Uint8Array
    ? new Uint8Array(content)
    : Uint8Array.from(content);
}

/**
 * Build a metadata-only AAF composition. The NLE will ask the user to relink
 * to the original media file by name.
 */
export async function writeAafComposition(input: AafExportInput): Promise<Blob> {
  const { keepRanges, duration, mediaFileName, frameRate, withVideo, withAudio } =
    input;
  if (keepRanges.length === 0) {
    throw new Error("Everything has been deleted — nothing to export.");
  }
  if (keepRanges.length > AAF_MAX_CLIPS) {
    throw new Error(
      `AAF export supports up to ${AAF_MAX_CLIPS} clips (this edit has ${keepRanges.length}).`
    );
  }
  if (!withVideo && !withAudio) {
    throw new Error("Nothing to put on the AAF timeline.");
  }

  const scaffold = await loadScaffold();
  const cfb = CFB.parse(new Uint8Array(scaffold));

  const fittedName = fitAafMediaName(mediaFileName);
  const realUrl = aafMediaFileUrl(mediaFileName);

  for (let i = 0; i < cfb.FileIndex.length; i++) {
    const entry = cfb.FileIndex[i];
    const path = cfb.FullPaths[i] ?? "";
    if (!entry?.content || entry.content.length === 0) continue;

    // NetworkLocator URL — variable-length rewrite so the path stays exact.
    if (/Locator-2f01\{0\}\/properties$/.test(path)) {
      entry.content = writeLocatorProperties(realUrl);
      continue;
    }

    const buf = ensureContent(entry.content);
    replaceUtf16InPlace(buf, MARKER_NAME, fittedName);
    // Leave MARKER_URL alone here; locator stream handled above.
    entry.content = buf;
  }

  const rate = FRAME_RATE_RATIONAL[frameRate];
  const sourceFrames = Math.max(1, secondsToFrames(duration, frameRate));
  const clips = keepRanges.map((r) => {
    const start = secondsToFrames(r.start, frameRate);
    const end = secondsToFrames(r.end, frameRate);
    return { start, length: Math.max(1, end - start) };
  });
  const n = clips.length;

  const pictureCount = withVideo ? n : 0;
  const soundCount = withAudio ? n : 0;

  for (let i = 0; i < cfb.FullPaths.length; i++) {
    const path = cfb.FullPaths[i];
    const entry = cfb.FileIndex[i];
    if (!entry) continue;

    const clipMatch = path.match(
      /Mobs-1901\{2\}\/Slots-4403\{([01])\}\/Segment-4803\/Components-1001\{([0-9a-f]+)\}\/properties$/
    );
    if (clipMatch) {
      const slot = Number(clipMatch[1]);
      const key = parseInt(clipMatch[2], 16);
      const count = slot === 0 ? pictureCount : soundCount;
      if (key < count) {
        const buf = ensureContent(entry.content);
        patchClipProperties(buf, clips[key].start, clips[key].length);
        entry.content = buf;
      }
      continue;
    }

    const indexMatch = path.match(
      /Mobs-1901\{2\}\/Slots-4403\{([01])\}\/Segment-4803\/Components-1001 index$/
    );
    if (indexMatch) {
      const slot = Number(indexMatch[1]);
      const count = slot === 0 ? pictureCount : soundCount;
      entry.content = writeComponentsIndex(count, AAF_MAX_CLIPS);
      continue;
    }

    if (/Slots-4403\{\d+\}\/properties$/.test(path)) {
      const buf = ensureContent(entry.content);
      patchEditRate(buf, rate.num, rate.den);
      entry.content = buf;
      continue;
    }

    const srcLenMatch = path.match(
      /Mobs-1901\{0\}\/Slots-4403\{([01])\}\/Segment-4803\/properties$/
    );
    if (srcLenMatch) {
      const buf = ensureContent(entry.content);
      const offsets = dataOffsetsByPid(buf);
      const lengthOff = offsets.get(0x0202);
      if (lengthOff != null) {
        writeI64LE(buf, lengthOff, sourceFrames);
        entry.content = buf;
      }
    }
  }

  const out = CFB.write(cfb, { type: "array" }) as number[] | Uint8Array;
  const bytes =
    out instanceof Uint8Array ? out : Uint8Array.from(out as number[]);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: "application/octet-stream" });
}
