import type { AlignToken } from "./alignTranscript";
import type { Word } from "./types";

/** Caption / transcript files we can turn into timed or syncable words. */
export const TRANSCRIPT_ACCEPT =
  ".srt,.vtt,.json,.txt,application/json,text/vtt,text/plain";

const TRANSCRIPT_EXT = /\.(srt|vtt|json|txt)$/i;

export function isTranscriptFile(file: File): boolean {
  return (
    TRANSCRIPT_EXT.test(file.name) ||
    file.type === "application/json" ||
    file.type === "text/vtt" ||
    file.type === "text/plain"
  );
}

/** Timed captions, or plain text that must be synced to audio (Descript-style). */
export type ParsedTranscript =
  | { kind: "timed"; words: Word[] }
  | { kind: "untimed"; tokens: AlignToken[] };

interface Cue {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

/**
 * Parse an SRT, WebVTT, JSON, or plain-text transcript.
 * Timed formats become editor `Word`s; plain text becomes tokens for sync.
 */
export function parseTranscript(text: string, filename = ""): ParsedTranscript {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error("That transcript file is empty.");

  const lower = filename.toLowerCase();

  // Explicit plain-text files always sync (even if they happen to look like SRT).
  if (lower.endsWith(".txt")) {
    return { kind: "untimed", tokens: tokensFromPlainText(trimmed) };
  }

  if (lower.endsWith(".json") || looksLikeJson(trimmed)) {
    return { kind: "timed", words: wordsFromJson(trimmed) };
  }
  if (lower.endsWith(".vtt") || /^WEBVTT/i.test(trimmed)) {
    return { kind: "timed", words: wordsFromCues(parseVtt(trimmed)) };
  }
  if (lower.endsWith(".srt") || looksLikeSrt(trimmed)) {
    return { kind: "timed", words: wordsFromCues(parseSrt(trimmed)) };
  }

  // Extension missing / wrong: prefer timed formats, then plain text.
  try {
    return { kind: "timed", words: wordsFromJson(trimmed) };
  } catch {
    /* continue */
  }
  if (/^WEBVTT/i.test(trimmed)) {
    return { kind: "timed", words: wordsFromCues(parseVtt(trimmed)) };
  }
  if (looksLikeSrt(trimmed)) {
    return { kind: "timed", words: wordsFromCues(parseSrt(trimmed)) };
  }

  return { kind: "untimed", tokens: tokensFromPlainText(trimmed) };
}

export async function parseTranscriptFile(
  file: File
): Promise<ParsedTranscript> {
  const text = await file.text();
  return parseTranscript(text, file.name);
}

/**
 * Split plain text into tokens. Speaker labels use Descript's convention:
 * `Speaker Name: dialogue text` (label applies until the next labeled line).
 */
export function tokensFromPlainText(text: string): AlignToken[] {
  const speakerIds = new Map<string, number>();
  let nextSpeaker = 0;
  let speaker = 0;
  const tokens: AlignToken[] = [];

  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    const labeled = line.match(/^([A-Za-z][\w\s'-]{0,40}):\s+(.+)$/);
    if (labeled) {
      const name = labeled[1].trim();
      if (!speakerIds.has(name)) speakerIds.set(name, nextSpeaker++);
      speaker = speakerIds.get(name)!;
      line = labeled[2].trim();
    }

    for (const t of line.split(/\s+/).filter(Boolean)) {
      tokens.push({ text: t, speaker });
    }
  }

  if (tokens.length === 0) {
    throw new Error("No words found in that transcript.");
  }
  return tokens;
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

function wordsFromJson(text: string): Word[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Could not parse that JSON transcript.");
  }

  const rows = Array.isArray(data)
    ? data
    : data &&
        typeof data === "object" &&
        Array.isArray((data as { words?: unknown }).words)
      ? (data as { words: unknown[] }).words
      : null;
  if (!rows) {
    throw new Error('JSON must be a word array or { "words": [...] }.');
  }

  const nameToIdx = new Map<string, number>();
  let nextSpeaker = 0;
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
      if (!nameToIdx.has(name)) nameToIdx.set(name, nextSpeaker++);
      speaker = nameToIdx.get(name)!;
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

  if (words.length === 0) {
    throw new Error("No timed words found in that transcript.");
  }
  return words;
}

function parseSrt(text: string): Cue[] {
  const blocks = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\n+/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
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

function wordsFromCues(cues: Cue[]): Word[] {
  const speakerIds = new Map<string, number>();
  let nextSpeaker = 0;
  const words: Word[] = [];
  let id = 0;

  for (const cue of cues) {
    const tokens = cue.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    let speaker = 0;
    if (cue.speaker) {
      if (!speakerIds.has(cue.speaker)) speakerIds.set(cue.speaker, nextSpeaker++);
      speaker = speakerIds.get(cue.speaker)!;
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

  if (words.length === 0) {
    throw new Error("No timed words found in that transcript.");
  }
  return words;
}
