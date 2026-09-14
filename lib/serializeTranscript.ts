import { en } from "@/lib/i18n/messages/en";
import { getCutRanges, originalToEdited } from "./edits";
import { speakerLabel, speakersFromWords } from "./speakers";
import { groupWordsBySpeaker } from "./transcript";
import type { SpeakerInfo, TimeRange, Word } from "./types";
import { zipStore } from "./zipStore";

/** Timed caption / subtitle formats (importable). */
export type SubtitleFormat = "srt" | "vtt" | "json";

/** Transcript document formats (speaker turns). */
export type TranscriptDocFormat = "txt" | "md" | "docx" | "pdf";

export type TranscriptFormat = SubtitleFormat | TranscriptDocFormat;

export interface SerializeOptions {
  /**
   * When true (default for SRT/VTT/TXT/MD/DOCX/PDF), omit cut words and remap
   * times onto the edited timeline so captions sync with the exported media.
   * JSON ignores this and always writes the full word list for round-trips.
   */
  editedTimeline?: boolean;
  /** Media duration in seconds; used when remapping onto the edited timeline. */
  duration?: number;
  /**
   * Precomputed cut ranges (deleted words ∪ manual cuts). Preferred so caption
   * times match the media export. Falls back to word-derived cuts when omitted.
   */
  cuts?: TimeRange[];
  /** Named speakers for labels in captions / documents / JSON. */
  speakers?: SpeakerInfo[];
  /** Prefix each speaker turn with its start time (document formats only). */
  timestamps?: boolean;
  /**
   * When true (default for SRT/VTT), split captions into short sentence-sized
   * cues (≤{@link MAX_CUE_DURATION}s, wrapped lines). When false, only split
   * on speaker changes and pause gaps (legacy long cues).
   */
  shortCues?: boolean;
}

interface Cue {
  start: number;
  end: number;
  text: string;
  speaker: number;
}

interface DocumentTurn {
  speaker: number;
  text: string;
  start: number;
}

/** Split a cue when the gap between consecutive words exceeds this (seconds). */
const CUE_GAP = 0.75;
/**
 * Max on-screen duration for one caption cue (seconds) when short cues are on.
 * Continuous speech with no long pause used to become a single 60s+ cue.
 */
const MAX_CUE_DURATION = 5;
/**
 * Soft max characters of dialogue in one cue (≈ two 42-char lines). Keeps
 * exported SRT/VTT from dumping a whole paragraph onto the video frame.
 */
const MAX_CUE_CHARS = 84;
/** Preferred line width when wrapping cue text for display. */
const CUE_LINE_CHARS = 42;

const MIME: Record<TranscriptFormat, string> = {
  srt: "application/x-subrip",
  vtt: "text/vtt",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export function transcriptMime(format: TranscriptFormat): string {
  return MIME[format];
}

export function transcriptExtension(format: TranscriptFormat): string {
  return `.${format}`;
}

/**
 * Serialize editor words to a subtitle or text transcript format.
 * Binary formats (DOCX / PDF) use {@link serializeTranscriptBinary}.
 */
export function serializeTranscript(
  words: Word[],
  format: Exclude<TranscriptFormat, "docx" | "pdf">,
  options: SerializeOptions = {}
): string {
  // Always re-derive against the word list so a stale speakers snapshot can't
  // leave labels stuck on defaults after rename / replace-in-project.
  const speakers = speakersFromWords(words, options.speakers ?? []);
  if (format === "json") return serializeJson(words, speakers);
  if (format === "txt" || format === "md") {
    return serializeDocument(words, format, { ...options, speakers });
  }

  const editedTimeline = options.editedTimeline !== false;
  const prepared = prepareCaptionWords(words, editedTimeline, options);
  if (prepared.length === 0) {
    throw new Error(en["error.noWords"]);
  }
  const shortCues = options.shortCues !== false;
  const cues = wordsToCues(prepared, shortCues);
  return format === "vtt"
    ? serializeVtt(cues, speakers, shortCues)
    : serializeSrt(cues, speakers, shortCues);
}

/** Serialize to DOCX or PDF (binary). */
export function serializeTranscriptBinary(
  words: Word[],
  format: "docx" | "pdf",
  options: SerializeOptions = {}
): Uint8Array {
  const speakers = speakersFromWords(words, options.speakers ?? []);
  const turns = buildDocumentTurns(words, { ...options, speakers });
  if (format === "docx") return serializeDocx(turns, speakers, options.timestamps);
  return serializePdf(turns, speakers, options.timestamps);
}

/** Trigger a browser download of the serialized transcript / subtitles. */
export function downloadTranscript(
  words: Word[],
  format: TranscriptFormat,
  filename: string,
  options: SerializeOptions = {}
): void {
  const name = filename.endsWith(`.${format}`)
    ? filename
    : `${filename}${transcriptExtension(format)}`;

  let blob: Blob;
  if (format === "docx" || format === "pdf") {
    const bytes = serializeTranscriptBinary(words, format, options);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    blob = new Blob([copy], { type: MIME[format] });
  } else {
    const text = serializeTranscript(words, format, options);
    blob = new Blob([text], { type: `${MIME[format]};charset=utf-8` });
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function serializeJson(words: Word[], speakers: SpeakerInfo[]): string {
  return JSON.stringify(
    {
      speakers: speakers.map((s) => ({ id: s.id, name: s.name })),
      words: words.map((w) => ({
        text: w.text,
        start: roundTime(w.start),
        end: roundTime(w.end),
        speaker: w.speaker,
        deleted: w.deleted,
      })),
    },
    null,
    2
  );
}

function buildDocumentTurns(
  words: Word[],
  options: SerializeOptions
): DocumentTurn[] {
  const editedTimeline = options.editedTimeline !== false;
  const prepared = prepareCaptionWords(words, editedTimeline, options);
  if (prepared.length === 0) {
    throw new Error(en["error.noWords"]);
  }

  return groupWordsBySpeaker(prepared).map((turn) => ({
    speaker: turn.speaker,
    text: turn.words.map((w) => w.text).join(" "),
    start: turn.words[0]?.start ?? 0,
  }));
}

function serializeDocument(
  words: Word[],
  format: "txt" | "md",
  options: SerializeOptions
): string {
  const speakers = speakersFromWords(words, options.speakers ?? []);
  const turns = buildDocumentTurns(words, { ...options, speakers });
  const withTs = Boolean(options.timestamps);

  if (format === "txt") {
    return (
      turns
        .map((turn) => {
          const label = speakerLabel(speakers, turn.speaker);
          const prefix = withTs
            ? `[${formatTranscriptTimestamp(turn.start)}] ${label}`
            : label;
          return `${prefix}: ${turn.text}`;
        })
        .join("\n\n") + "\n"
    );
  }

  return (
    turns
      .map((turn) => {
        const label = speakerLabel(speakers, turn.speaker);
        const heading = withTs
          ? `**[${formatTranscriptTimestamp(turn.start)}] ${label}**`
          : `**${label}**`;
        return `${heading}\n\n${turn.text}`;
      })
      .join("\n\n") + "\n"
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serializeDocx(
  turns: DocumentTurn[],
  speakers: SpeakerInfo[],
  timestamps?: boolean
): Uint8Array {
  const paragraphs = turns
    .map((turn) => {
      const label = speakerLabel(speakers, turn.speaker);
      const heading = timestamps
        ? `[${formatTranscriptTimestamp(turn.start)}] ${label}`
        : label;
      return [
        // Speaker heading (bold)
        `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(heading)}</w:t></w:r></w:p>`,
        // Body
        `<w:p><w:pPr><w:spacing w:after="240"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(turn.text)}</w:t></w:r></w:p>`,
      ].join("");
    })
    .join("");

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  return zipStore([
    { path: "[Content_Types].xml", data: contentTypes },
    { path: "_rels/.rels", data: rels },
    { path: "word/document.xml", data: documentXml },
  ]);
}

/** Compact turn timestamp for documents: `H:MM:SS` or `M:SS`. */
export function formatTranscriptTimestamp(seconds: number): string {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  if (h > 0) {
    return `${h}:${pad(m, 2)}:${pad(s, 2)}`;
  }
  return `${m}:${pad(s, 2)}`;
}

function prepareCaptionWords(
  words: Word[],
  editedTimeline: boolean,
  options: SerializeOptions
): Word[] {
  const duration = options.duration ?? 0;
  const cuts =
    options.cuts ??
    getCutRanges(words, duration > 0 ? duration : Infinity);

  const kept = words.filter((w) => isWordKept(w, cuts));
  if (!editedTimeline || kept.length === 0 || cuts.length === 0) return kept;

  return kept.map((w) => ({
    ...w,
    start: originalToEdited(w.start, cuts),
    end: originalToEdited(w.end, cuts),
  }));
}

/** Keep words that are not deleted and whose midpoint survives the cut list. */
function isWordKept(word: Word, cuts: TimeRange[]): boolean {
  if (word.deleted) return false;
  const mid = (word.start + word.end) / 2;
  return !cuts.some((c) => mid >= c.start && mid < c.end);
}

/**
 * Group timed words into caption cues.
 *
 * Always splits on speaker change and pause gaps. When `shortCues` is on, also
 * splits on sentence-ending punctuation and hard-caps duration / character
 * count so continuous speech cannot produce a single oversized on-screen block.
 */
function wordsToCues(words: Word[], shortCues: boolean): Cue[] {
  const cues: Cue[] = [];
  let batch: Word[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    const cue: Cue = {
      start: batch[0].start,
      end: Math.max(batch[batch.length - 1].end, batch[0].start + 0.02),
      text: batch.map((w) => w.text).join(" "),
      speaker: batch[0].speaker,
    };
    batch = [];

    // Absorb tiny trailing fragments (e.g. a lone "exporter.") into the previous
    // cue when the previous cue was mid-sentence and the fragment still fits.
    const prev = cues[cues.length - 1];
    if (
      shortCues &&
      prev &&
      prev.speaker === cue.speaker &&
      !endsSentence(prev.text) &&
      cue.start - prev.end <= CUE_GAP &&
      cue.end - cue.start < 1.25 &&
      cue.text.length <= 24 &&
      cue.end - prev.start <= MAX_CUE_DURATION &&
      wrapCueLines(`${prev.text} ${cue.text}`, CUE_LINE_CHARS).length <= 2
    ) {
      prev.end = cue.end;
      prev.text = `${prev.text} ${cue.text}`;
      return;
    }
    cues.push(cue);
  };

  const wouldOverflow = (next: Word): boolean => {
    if (!shortCues || batch.length === 0) return false;
    const text = `${batch.map((w) => w.text).join(" ")} ${next.text}`;
    const duration = next.end - batch[0].start;
    if (duration > MAX_CUE_DURATION) return true;
    // Let a short lowercase sentence-final token finish the current cue
    // ("… the old" + "exporter.") instead of becoming a one-word orphan.
    if (
      endsSentence(next.text) &&
      next.text.length <= 24 &&
      !/^\p{Lu}/u.test(next.text)
    ) {
      return false;
    }
    return (
      wrapCueLines(text, CUE_LINE_CHARS).length > 2 ||
      text.length > MAX_CUE_CHARS
    );
  };

  for (const w of words) {
    const last = batch[batch.length - 1];
    if (last) {
      const speakerOrGap =
        w.speaker !== last.speaker || w.start - last.end > CUE_GAP;
      if (speakerOrGap || wouldOverflow(w)) {
        flush();
      }
    }
    batch.push(w);
    // Prefer a new cue after each sentence so timestamps stay line/sentence sized.
    if (shortCues && endsSentence(w.text)) flush();
  }
  flush();
  return cues;
}

/** True when a word looks like the end of a sentence (ASR usually keeps the mark). */
function endsSentence(text: string): boolean {
  return /[.!?…。？！]["'"”’」』】）)\]]*$/u.test(text.trim());
}

function formatCueBody(
  text: string,
  speakerPrefix: string | undefined,
  wrap: boolean
): string {
  if (!wrap) {
    return speakerPrefix ? `${speakerPrefix}${text}` : text;
  }
  const wrapped = wrapCueLines(text, CUE_LINE_CHARS);
  if (!speakerPrefix) return wrapped.join("\n");
  if (wrapped.length === 0) return speakerPrefix.trimEnd();
  return [`${speakerPrefix}${wrapped[0]}`, ...wrapped.slice(1)].join("\n");
}

function wrapCueLines(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    if (word.length <= maxChars) {
      current = word;
    } else {
      for (let i = 0; i < word.length; i += maxChars) {
        const chunk = word.slice(i, i + maxChars);
        if (i + maxChars < word.length) lines.push(chunk);
        else current = chunk;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function serializeSrt(
  cues: Cue[],
  speakers: SpeakerInfo[],
  shortCues: boolean
): string {
  return (
    cues
      .map((cue, i) => {
        const lines = [
          String(i + 1),
          `${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}`,
        ];
        if (cue.speaker >= 0) {
          lines.push(
            formatCueBody(
              cue.text,
              `${speakerLabel(speakers, cue.speaker)}: `,
              shortCues
            )
          );
        } else {
          lines.push(formatCueBody(cue.text, undefined, shortCues));
        }
        return lines.join("\n");
      })
      .join("\n\n") + "\n"
  );
}

function serializeVtt(
  cues: Cue[],
  speakers: SpeakerInfo[],
  shortCues: boolean
): string {
  const body = cues
    .map((cue) => {
      const timing = `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}`;
      const dialogue = shortCues
        ? wrapCueLines(cue.text, CUE_LINE_CHARS).join("\n")
        : cue.text;
      const text =
        cue.speaker >= 0
          ? `<v ${speakerLabel(speakers, cue.speaker)}>${dialogue}`
          : dialogue;
      return `${timing}\n${text}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

/** SRT timestamps use a comma decimal separator: `HH:MM:SS,mmm`. */
export function formatSrtTimestamp(seconds: number): string {
  return formatCaptionTimestamp(seconds, ",");
}

/** WebVTT timestamps use a dot decimal separator: `HH:MM:SS.mmm`. */
export function formatVttTimestamp(seconds: number): string {
  return formatCaptionTimestamp(seconds, ".");
}

function formatCaptionTimestamp(seconds: number, decimal: "," | "."): string {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  // Carry if rounding pushed ms to 1000.
  const carry = ms === 1000 ? 1 : 0;
  const msClamped = ms === 1000 ? 0 : ms;
  const s2 = s + carry;
  const m2 = m + Math.floor(s2 / 60);
  const h2 = h + Math.floor(m2 / 60);
  return (
    `${pad(h2, 2)}:${pad(m2 % 60, 2)}:${pad(s2 % 60, 2)}` +
    `${decimal}${pad(msClamped, 3)}`
  );
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function roundTime(t: number): number {
  return Math.round(t * 1000) / 1000;
}

// --- Minimal PDF (Helvetica / WinAnsi; non-encodable chars become "?") ---

function pdfEscape(text: string): string {
  return winAnsi(text)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Map Unicode to WinAnsi where possible; replace the rest. */
function winAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += " ";
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
      continue;
    }
    // Common Latin-1 Supplement that WinAnsi covers (0xA0–0xFF, with gaps).
    if (code >= 0xa0 && code <= 0xff) {
      out += String.fromCharCode(code);
      continue;
    }
    const mapped = WINANSI_MAP[code];
    out += mapped ?? "?";
  }
  return out;
}

const WINANSI_MAP: Record<number, string> = {
  0x2018: "'",
  0x2019: "'",
  0x201c: '"',
  0x201d: '"',
  0x2013: "-",
  0x2014: "-",
  0x2026: "...",
  0x00a0: " ",
};

function wrapPdfLine(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
    } else {
      if (current) lines.push(current);
      if (word.length <= maxChars) {
        current = word;
      } else {
        // Hard-break very long tokens.
        for (let i = 0; i < word.length; i += maxChars) {
          const chunk = word.slice(i, i + maxChars);
          if (i + maxChars < word.length) lines.push(chunk);
          else current = chunk;
        }
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function serializePdf(
  turns: DocumentTurn[],
  speakers: SpeakerInfo[],
  timestamps?: boolean
): Uint8Array {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 54;
  const bodySize = 11;
  const headSize = 12;
  const lineHeight = 16;
  const maxChars = 86;

  type PdfLine = { text: string; bold: boolean };
  const allLines: PdfLine[] = [];
  for (const turn of turns) {
    const label = speakerLabel(speakers, turn.speaker);
    const heading = timestamps
      ? `[${formatTranscriptTimestamp(turn.start)}] ${label}`
      : label;
    allLines.push({ text: heading, bold: true });
    for (const line of wrapPdfLine(turn.text, maxChars)) {
      allLines.push({ text: line, bold: false });
    }
    allLines.push({ text: "", bold: false });
  }

  const usableHeight = pageHeight - margin * 2;
  const linesPerPage = Math.max(1, Math.floor(usableHeight / lineHeight));
  const pages: PdfLine[][] = [];
  for (let i = 0; i < allLines.length; i += linesPerPage) {
    pages.push(allLines.slice(i, i + linesPerPage));
  }
  if (pages.length === 0) pages.push([]);

  const objects: string[] = [];
  const offsets: number[] = [0];

  const addObject = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  // 1 Catalog, 2 Pages placeholder filled later, 3 Helvetica, 4 Helvetica-Bold
  addObject("<< /Type /Catalog /Pages 2 0 R >>");
  addObject("PLACEHOLDER_PAGES");
  const fontReg = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBold = addObject(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"
  );

  const pageObjectNumbers: number[] = [];

  for (const pageLines of pages) {
    const contentParts: string[] = ["BT"];
    let y = pageHeight - margin;
    let lastBold: boolean | null = null;
    for (const line of pageLines) {
      if (lastBold !== line.bold) {
        contentParts.push(`/${line.bold ? "FBold" : "FReg"} ${line.bold ? headSize : bodySize} Tf`);
        lastBold = line.bold;
      }
      contentParts.push(`1 0 0 1 ${margin} ${y} Tm (${pdfEscape(line.text)}) Tj`);
      y -= lineHeight;
    }
    contentParts.push("ET");
    const stream = contentParts.join("\n");
    const streamObj = addObject(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    );
    const pageObj = addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /FReg ${fontReg} 0 R /FBold ${fontBold} 0 R >> >> /Contents ${streamObj} 0 R >>`
    );
    pageObjectNumbers.push(pageObj);
  }

  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers
    .map((n) => `${n} 0 R`)
    .join(" ")}] /Count ${pageObjectNumbers.length} >>`;

  // Content is WinAnsi/ASCII, so string length == byte length.
  const parts: string[] = ["%PDF-1.4\n"];
  let cursor = parts[0].length;
  offsets[0] = 0;
  for (let i = 0; i < objects.length; i++) {
    offsets[i + 1] = cursor;
    const chunk = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    parts.push(chunk);
    cursor += chunk.length;
  }
  const xrefPos = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  parts.push(xref);
  parts.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  );
  return new TextEncoder().encode(parts.join(""));
}
