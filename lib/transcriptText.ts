/**
 * Plain-text projection of the transcript for screen readers (see
 * components/TranscriptTextLayer.tsx). The visual transcript is one span per
 * word, which NVDA / VoiceOver can't navigate or edit; a native textarea can.
 * This module builds that text and maps caret offsets back to word ids so
 * edits made in the textarea land on the right words.
 */

import type { SpeakerTurn } from "./types";

/** Where one word sits in the projected text: [start, end) char offsets. */
export interface TextSegment {
  id: number;
  start: number;
  end: number;
}

export interface TranscriptText {
  text: string;
  /** In text order, non-overlapping. */
  segments: TextSegment[];
}

/**
 * One line per speaker turn — "Name: word word word" — so line navigation
 * (up / down arrow) moves between speakers and word navigation stays on words.
 */
export function buildTranscriptText(
  turns: SpeakerTurn[],
  speakerName: (speaker: number) => string,
  wordText: (text: string) => string = (text) => text
): TranscriptText {
  let text = "";
  const segments: TextSegment[] = [];
  for (const turn of turns) {
    if (turn.words.length === 0) continue;
    if (text) text += "\n";
    text += `${speakerName(turn.speaker)}: `;
    turn.words.forEach((w, i) => {
      if (i > 0) text += " ";
      const start = text.length;
      text += wordText(w.text);
      segments.push({ id: w.id, start, end: text.length });
    });
  }
  return { text, segments };
}

/** Words touched by the selection [start, end). Empty when collapsed. */
export function wordIdsInRange(
  segments: TextSegment[],
  start: number,
  end: number
): number[] {
  if (end <= start) return [];
  return segments
    .filter((seg) => seg.start < end && seg.end > start)
    .map((seg) => seg.id);
}

/** Index of the word containing the caret (edges included), or -1. */
function segmentIndexAt(segments: TextSegment[], caret: number): number {
  return segments.findIndex((seg) => caret >= seg.start && caret <= seg.end);
}

/**
 * The word a collapsed caret "is on": the word containing it, else the next
 * word (caret in a gap or a speaker prefix), else the last word.
 */
export function wordIdAtCaret(
  segments: TextSegment[],
  caret: number
): number | null {
  const inside = segmentIndexAt(segments, caret);
  if (inside >= 0) return segments[inside].id;
  const next = segments.find((seg) => seg.start >= caret);
  return next?.id ?? segments[segments.length - 1]?.id ?? null;
}

/**
 * The word Backspace / Delete removes from a collapsed caret: the word the
 * caret is inside, else the nearest word in that direction.
 */
export function wordIdForDelete(
  segments: TextSegment[],
  caret: number,
  direction: "backward" | "forward"
): number | null {
  const inside = segments.findIndex(
    (seg) => caret > seg.start && caret < seg.end
  );
  if (inside >= 0) return segments[inside].id;
  if (direction === "backward") {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].end <= caret) return segments[i].id;
    }
    return null;
  }
  return segments.find((seg) => seg.start >= caret)?.id ?? null;
}

/** Start offset of the word, or null when it isn't in the text. */
export function wordStartOffset(
  segments: TextSegment[],
  id: number
): number | null {
  return segments.find((seg) => seg.id === id)?.start ?? null;
}
