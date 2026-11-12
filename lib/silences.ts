import { getCutRanges, isWordCutOut } from "./edits";
import { copyOf, copyRange, ofCopy, sourceOrder } from "./sequence";
import type { CopyRange, ManualCut, SourceCopy, TimeRange, Word } from "./types";

/**
 * Minimum gap length (seconds) that counts as a removable silence.
 * Shorter gaps are normal inter-word spacing from ASR and should stay.
 */
export const MIN_SILENCE_DURATION = 0.3;

/**
 * Leave this much audio (seconds) beside kept speech so word onsets/offsets
 * aren't clipped when Whisper timestamps are slightly tight.
 */
export const SILENCE_PAD = 0.05;

/**
 * Manual cuts that hold no words at all — what "Remove silences" leaves behind
 * (and any trim that happened to land on a pause). Restoring these brings the
 * quiet audio back without un-deleting speech, so a cut that merged with a
 * word-bearing cut is deliberately left out.
 */
export function findSilenceCuts(
  words: Word[],
  manualCuts: ManualCut[]
): TimeRange[] {
  return manualCuts
    .filter(
      (c) =>
        c.end - c.start > 1e-4 &&
        !words.some((w) => w.end > c.start + 1e-4 && w.start < c.end - 1e-4)
    )
    .map((c) => ({ start: c.start, end: c.end }));
}

/** Split `range` into the pieces not covered by any of `cuts`. */
function subtractCuts(range: TimeRange, cuts: TimeRange[]): TimeRange[] {
  let parts: TimeRange[] = [range];
  for (const cut of cuts) {
    parts = parts.flatMap((p) => {
      if (cut.end <= p.start + 1e-4 || cut.start >= p.end - 1e-4) return [p];
      const out: TimeRange[] = [];
      if (cut.start > p.start + 1e-4) out.push({ start: p.start, end: cut.start });
      if (cut.end < p.end - 1e-4) out.push({ start: cut.end, end: p.end });
      return out;
    });
  }
  return parts;
}

/**
 * Find silence ranges in the media that are not already cut: gaps before the
 * first kept word, between kept words, and after the last kept word, each at
 * least `minDuration` long. A small pad is left beside speech so it isn't
 * clipped; media edges are cut flush.
 */
export function findSilenceRanges(
  words: Word[],
  duration: number,
  manualCuts: ManualCut[] = [],
  minDuration = MIN_SILENCE_DURATION,
  pad = SILENCE_PAD
): TimeRange[] {
  if (duration <= 0) return [];

  const cuts = getCutRanges(words, duration, manualCuts);
  const kept = words
    .filter((w) => !isWordCutOut(w, cuts))
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);

  // Raw gaps (no pad yet), tagged with whether each edge abuts speech.
  type Gap = { start: number; end: number; padStart: boolean; padEnd: boolean };
  const gaps: Gap[] = [];
  let cursor = 0;
  let prevWasSpeech = false;
  for (const w of kept) {
    if (w.start > cursor + 1e-4) {
      gaps.push({
        start: cursor,
        end: w.start,
        padStart: prevWasSpeech,
        padEnd: true,
      });
    }
    cursor = Math.max(cursor, w.end);
    prevWasSpeech = true;
  }
  if (duration > cursor + 1e-4) {
    gaps.push({
      start: cursor,
      end: duration,
      padStart: prevWasSpeech,
      padEnd: false,
    });
  }

  const out: TimeRange[] = [];
  for (const gap of gaps) {
    if (gap.end - gap.start < minDuration - 1e-4) continue;
    for (const part of subtractCuts(
      { start: gap.start, end: gap.end },
      cuts
    )) {
      if (part.end - part.start < minDuration - 1e-4) continue;
      // Only pad edges that still sit against speech (not against a prior cut).
      const padStart = gap.padStart && Math.abs(part.start - gap.start) < 1e-4;
      const padEnd = gap.padEnd && Math.abs(part.end - gap.end) < 1e-4;
      const start = part.start + (padStart ? pad : 0);
      const end = part.end - (padEnd ? pad : 0);
      if (end - start > 1e-4) out.push({ start, end });
    }
  }
  return out;
}

/**
 * findSilenceRanges for every copy of the media: the original over the whole
 * file, each pasted duplicate within its own range. Each range names its copy.
 */
export function findCopySilenceRanges(
  words: Word[],
  duration: number,
  manualCuts: ManualCut[],
  copies: SourceCopy[],
  minDuration = MIN_SILENCE_DURATION
): CopyRange[] {
  const out: CopyRange[] = [];
  const order = sourceOrder(words);
  if (!order.has(0)) order.set(0, []);
  for (const [copy, list] of order) {
    const copyWords = list.map((i) => words[i]);
    const range = copyRange(copy, copies, duration);
    // A duplicate with every word deleted is cut whole already.
    if (copy !== 0 && copyWords.every((w) => w.deleted)) continue;
    for (const r of findSilenceRanges(copyWords, range.end, ofCopy(manualCuts, copy), minDuration)) {
      const start = Math.max(r.start, range.start);
      if (r.end - start < minDuration - 1e-4) continue;
      out.push(copy === 0 ? { ...r, copy } : { start, end: r.end, copy });
    }
  }
  return out;
}

/** findSilenceCuts for every copy, each range naming its copy. */
export function findCopySilenceCuts(words: Word[], manualCuts: ManualCut[]): CopyRange[] {
  const out: CopyRange[] = [];
  for (const copy of new Set(manualCuts.map(copyOf))) {
    const copyWords = words.filter((w) => copyOf(w) === copy);
    for (const r of findSilenceCuts(copyWords, ofCopy(manualCuts, copy))) {
      out.push({ ...r, copy });
    }
  }
  return out;
}
