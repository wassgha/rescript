import { en } from "@/lib/i18n/messages/en";
import { defaultSpeakerName, speakersFromWords } from "./speakers";
import type { SpeakerInfo, Word } from "./types";

/** Caption / transcript files we can turn into timed words. */
export const TRANSCRIPT_ACCEPT =
  ".srt,.vtt,.json,application/json,text/vtt,text/plain";
export const TRANSCRIPT_FILE_ERROR = en["transcript.invalidFile"];

const TRANSCRIPT_EXT = /\.(srt|vtt|json)$/i;

export function isTranscriptFile(file: File): boolean {
  return (
    TRANSCRIPT_EXT.test(file.name) ||
    file.type === "application/json" ||
    file.type === "text/vtt"
  );
}

export interface ParsedTranscript {
  words: Word[];
  speakers: SpeakerInfo[];
}

interface Cue {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

/**
 * Parse an SRT, WebVTT, or JSON transcript into timed words + named speakers.
 * Cue text is split on whitespace; each cue's time span is distributed
 * across its tokens by character length (same idea as word correction).
 */
export function parseTranscript(
  text: string,
  filename = ""
): ParsedTranscript {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error(en["error.emptyTranscript"]);

  const lower = filename.toLowerCase();
  let parsed: ParsedTranscript;
  if (lower.endsWith(".json") || looksLikeJson(trimmed)) {
    parsed = wordsFromJson(trimmed);
  } else if (lower.endsWith(".vtt") || /^WEBVTT/i.test(trimmed)) {
    parsed = wordsFromCues(parseVtt(trimmed));
  } else if (lower.endsWith(".srt") || looksLikeSrt(trimmed)) {
    parsed = wordsFromCues(parseSrt(trimmed));
  } else {
    // Fallbacks when the extension is missing or wrong.
    try {
      parsed = wordsFromJson(trimmed);
    } catch {
      try {
        parsed = wordsFromCues(parseVtt(trimmed));
      } catch {
        parsed = wordsFromCues(parseSrt(trimmed));
      }
    }
  }

  if (parsed.words.length === 0) {
    throw new Error(en["error.noTimedWords"]);
  }
  return {
    words: parsed.words,
    speakers: speakersFromWords(parsed.words, parsed.speakers),
  };
}

export async function parseTranscriptFile(file: File): Promise<ParsedTranscript> {
  const text = await file.text();
  return parseTranscript(text, file.name);
}

/**
 * Take the file the user just picked out of a file input and reset the input.
 *
 * Read the file *before* clearing, because `input.files` is a live
 * `[SameObject]` FileList: assigning `input.value = ""` empties the same object
 * any earlier `input.files` reference points at, so a handler that clears first
 * and reads after sees an empty list and drops the file. Clearing afterwards is
 * what lets the user pick the same file again.
 *
 * Measured in Chromium 130: `const files = input.files; input.value = "";`
 * leaves `files.length === 0` and `files[0] === undefined`.
 */
export function takeSelectedTranscriptFile(input: HTMLInputElement): File | null {
  const file = input.files?.[0] ?? null;
  input.value = "";
  return file;
}

function looksLikeJson(text: string): boolean {
  const c = text[0];
  return c === "[" || c === "{";
}

function looksLikeSrt(text: string): boolean {
  return /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(
    text
  );
}

function wordsFromJson(text: string): ParsedTranscript {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(en["error.parseJson"]);
  }

  const rows = Array.isArray(data)
    ? data
    : data &&
        typeof data === "object" &&
        Array.isArray((data as { words?: unknown }).words)
      ? (data as { words: unknown[] }).words
      : null;
  if (!rows) {
    throw new Error(en["error.jsonShape"]);
  }

  const namedSpeakers = readSpeakerInfos(data);
  const nameToIdx = new Map<string, number>();
  let nextSpeaker = 0;
  for (const s of namedSpeakers) {
    nameToIdx.set(s.name.trim().toLowerCase(), s.id);
    nextSpeaker = Math.max(nextSpeaker, s.id + 1);
  }

  const words: Word[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const token = String(r.text ?? r.word ?? "").trim();
    const start = Number(r.start);
    const end = Number(r.end);
    if (!token || !Number.isFinite(start) || !Number.isFinite(end)) continue;

    let speaker = 0;
    if (typeof r.speaker === "number" && Number.isFinite(r.speaker)) {
      speaker = Math.max(0, Math.floor(r.speaker));
    } else if (typeof r.speaker === "string" && r.speaker.trim()) {
      const name = r.speaker.trim();
      const key = name.toLowerCase();
      if (!nameToIdx.has(key)) {
        nameToIdx.set(key, nextSpeaker);
        namedSpeakers.push({ id: nextSpeaker, name });
        nextSpeaker++;
      }
      speaker = nameToIdx.get(key)!;
    }

    const s = Math.max(0, start);
    words.push({
      id: words.length,
      text: token,
      start: s,
      end: Math.max(s + 0.02, end),
      speaker,
      deleted: Boolean(r.deleted),
    });
  }

  return { words, speakers: speakersFromWords(words, namedSpeakers) };
}

function readSpeakerInfos(data: unknown): SpeakerInfo[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const raw = (data as { speakers?: unknown }).speakers;
  if (!Array.isArray(raw)) return [];
  const out: SpeakerInfo[] = [];
  const seen = new Set<number>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = Number(r.id ?? r.index);
    if (!Number.isFinite(id) || id < 0 || seen.has(id)) continue;
    const name =
      typeof r.name === "string" && r.name.trim()
        ? r.name.trim()
        : defaultSpeakerName(id);
    seen.add(id);
    out.push({ id: Math.floor(id), name });
  }
  return out.sort((a, b) => a.id - b.id);
}

function parseSrt(text: string): Cue[] {
  const blocks = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\n+/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter((l, i, arr) => {
      // Keep blank lines out; allow content lines.
      return l.length > 0 || i === arr.length - 1;
    }).filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;
    if (idx >= lines.length) continue;
    const times = parseTimeRange(lines[idx]);
    if (!times) continue;
    const body = lines.slice(idx + 1).join("\n");
    const { text: cueText, speaker } = stripCueMeta(body);
    if (!cueText) continue;
    cues.push({ ...times, text: cueText, speaker });
  }
  return cues;
}

function parseVtt(text: string): Cue[] {
  let body = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Drop header + optional metadata until the first blank line after WEBVTT.
  body = body.replace(/^WEBVTT[^\n]*\n(?:.*\n)*?(?=\n)/i, "");
  const blocks = body.split(/\n\n+/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0 && !l.startsWith("NOTE"));
    if (lines.length === 0) continue;
    let idx = 0;
    // Optional cue identifier line before the arrow.
    if (!parseTimeRange(lines[0])) {
      if (lines.length < 2 || !parseTimeRange(lines[1])) continue;
      idx = 1;
    }
    const times = parseTimeRange(lines[idx]);
    if (!times) continue;
    const raw = lines.slice(idx + 1).join("\n");
    const { text: cueText, speaker } = stripCueMeta(raw);
    if (!cueText) continue;
    cues.push({ ...times, text: cueText, speaker });
  }
  return cues;
}

/** `00:00:01,000 --> 00:00:04,000` or `00:01.000 --> 00:04.000` (± cue settings). */
function parseTimeRange(line: string): { start: number; end: number } | null {
  const m = line.match(
    /^(\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3}/
  );
  if (!m) return null;
  const parts = line.split(/\s*-->\s*/);
  if (parts.length < 2) return null;
  const start = parseTimestamp(parts[0].trim());
  // End may have cue settings after it ("align:start position:0%").
  const endToken = parts[1].trim().split(/\s+/)[0];
  const end = parseTimestamp(endToken);
  if (start === null || end === null) return null;
  return { start, end: Math.max(end, start + 0.02) };
}

function parseTimestamp(raw: string): number | null {
  const t = raw.trim().replace(",", ".");
  const parts = t.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const sec = Number(parts[parts.length - 1]);
  const min = Number(parts[parts.length - 2]);
  const hr = parts.length === 3 ? Number(parts[0]) : 0;
  if (![sec, min, hr].every(Number.isFinite)) return null;
  return hr * 3600 + min * 60 + sec;
}

function stripCueMeta(raw: string): { text: string; speaker?: string } {
  let text = raw
    // VTT voice spans: <v Speaker>…</v> or <v Speaker>…
    .replace(/<\/?c[^>]*>/gi, "")
    .replace(/<\/?b>/gi, "")
    .replace(/<\/?i>/gi, "")
    .replace(/<\/?u>/gi, "");

  let speaker: string | undefined;
  const voiceOpen = text.match(/^<v(?:\.[^\s>]*)?\s+([^>]+)>([\s\S]*)$/i);
  if (voiceOpen) {
    speaker = voiceOpen[1].trim();
    text = voiceOpen[2].replace(/<\/v>\s*$/i, "");
  } else {
    // Strip any remaining tags; capture leading "Name: " speaker labels.
    text = text.replace(/<[^>]+>/g, "");
    const labeled = text.match(/^([A-Za-z][\w\s'-]{0,40}):\s+([\s\S]+)$/);
    if (labeled) {
      speaker = labeled[1].trim();
      text = labeled[2];
    }
  }

  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return { text, speaker };
}

function wordsFromCues(cues: Cue[]): ParsedTranscript {
  const speakerIds = new Map<string, number>();
  const speakers: SpeakerInfo[] = [];
  let nextSpeaker = 0;
  const words: Word[] = [];
  let id = 0;

  for (const cue of cues) {
    const tokens = cue.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    let speaker = 0;
    if (cue.speaker) {
      const key = cue.speaker.toLowerCase();
      if (!speakerIds.has(key)) {
        speakerIds.set(key, nextSpeaker);
        speakers.push({ id: nextSpeaker, name: cue.speaker });
        nextSpeaker++;
      }
      speaker = speakerIds.get(key)!;
    }

    const span = Math.max(0.02, cue.end - cue.start);
    const totalChars = tokens.reduce((n, t) => n + t.length, 0) || tokens.length;
    let cursor = cue.start;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const dur = (span * t.length) / totalChars;
      const end =
        i === tokens.length - 1 ? cue.end : Math.min(cue.end, cursor + dur);
      words.push({
        id: id++,
        text: t,
        start: cursor,
        end: Math.max(cursor + 0.02, end),
        speaker,
        deleted: false,
      });
      cursor = end;
    }
  }
  return { words, speakers: speakersFromWords(words, speakers) };
}
