import type { Word } from "./types";

/** One token from a plain-text transcript waiting to be timed against audio. */
export interface AlignToken {
  text: string;
  /** 0-based speaker index from `Name:` labels (0 when unlabeled). */
  speaker: number;
}

const MATCH = 2;
const MISMATCH = -1;
const GAP = -1;

/** Lowercase + strip punctuation so "Hello," matches Whisper's "hello". */
export function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}']+/gu, "");
}

/**
 * Align a reference (untimed) transcript to ASR words that already have
 * timestamps — same idea as Descript's "Sync" for pasted text.
 *
 * Uses Needleman–Wunsch on normalized tokens, then copies / interpolates
 * timings from the ASR anchors onto the reference words. Reference speaker
 * labels win over diarization.
 */
export function alignTranscript(
  reference: AlignToken[],
  asr: Word[],
  mediaDuration?: number
): Word[] {
  if (reference.length === 0) {
    throw new Error("That transcript has no words to sync.");
  }
  if (asr.length === 0) {
    throw new Error(
      "Could not sync — no speech was detected in the audio. Try a clearer clip."
    );
  }

  const refNorm = reference.map((t) => normalizeToken(t.text));
  const asrNorm = asr.map((w) => normalizeToken(w.text));

  // Drop empty normalized tokens from matching (keep indices into originals).
  const refIdx: number[] = [];
  const asrIdx: number[] = [];
  for (let i = 0; i < refNorm.length; i++) if (refNorm[i]) refIdx.push(i);
  for (let i = 0; i < asrNorm.length; i++) if (asrNorm[i]) asrIdx.push(i);

  const n = refIdx.length;
  const m = asrIdx.length;
  if (n === 0) {
    throw new Error("That transcript has no words to sync.");
  }

  // DP matrix: (n+1) x (m+1). Store as flat array.
  const cols = m + 1;
  const score = new Float64Array((n + 1) * (m + 1));
  const ptr = new Uint8Array((n + 1) * (m + 1)); // 0=diag, 1=up (ref gap), 2=left (asr gap)

  for (let i = 1; i <= n; i++) {
    score[i * cols] = i * GAP;
    ptr[i * cols] = 1;
  }
  for (let j = 1; j <= m; j++) {
    score[j] = j * GAP;
    ptr[j] = 2;
  }

  for (let i = 1; i <= n; i++) {
    const a = refNorm[refIdx[i - 1]];
    for (let j = 1; j <= m; j++) {
      const b = asrNorm[asrIdx[j - 1]];
      const diag =
        score[(i - 1) * cols + (j - 1)] + (a === b ? MATCH : MISMATCH);
      const up = score[(i - 1) * cols + j] + GAP;
      const left = score[i * cols + (j - 1)] + GAP;
      let best = diag;
      let p = 0;
      if (up > best) {
        best = up;
        p = 1;
      }
      if (left > best) {
        best = left;
        p = 2;
      }
      score[i * cols + j] = best;
      ptr[i * cols + j] = p;
    }
  }

  // Map each reference token → matched ASR word index (into `asr`), or -1.
  const matchAsr = new Int32Array(reference.length).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const p = ptr[i * cols + j];
    if (i > 0 && j > 0 && p === 0) {
      matchAsr[refIdx[i - 1]] = asrIdx[j - 1];
      i--;
      j--;
    } else if (i > 0 && (j === 0 || p === 1)) {
      i--;
    } else {
      j--;
    }
  }

  const duration =
    mediaDuration && mediaDuration > 0
      ? mediaDuration
      : asr[asr.length - 1]?.end ?? 0;

  // Build timed words: matched tokens take ASR times; gaps interpolate.
  const starts = new Float64Array(reference.length);
  const ends = new Float64Array(reference.length);

  for (let r = 0; r < reference.length; r++) {
    const a = matchAsr[r];
    if (a >= 0) {
      starts[r] = asr[a].start;
      ends[r] = Math.max(asr[a].start + 0.02, asr[a].end);
    }
  }

  // Fill unmatched runs between anchors (and leading/trailing edges).
  let r = 0;
  while (r < reference.length) {
    if (matchAsr[r] >= 0) {
      r++;
      continue;
    }
    const runStart = r;
    while (r < reference.length && matchAsr[r] < 0) r++;
    const runEnd = r; // exclusive

    const prev = runStart - 1;
    const next = runEnd < reference.length ? runEnd : -1;
    const t0 =
      prev >= 0 ? ends[prev] : next >= 0 ? Math.max(0, starts[next] - 0.05) : 0;
    const t1 =
      next >= 0
        ? starts[next]
        : Math.max(t0 + 0.05 * (runEnd - runStart), duration);

    const span = Math.max(0.02 * (runEnd - runStart), t1 - t0);
    const tokens = reference.slice(runStart, runEnd);
    const totalChars =
      tokens.reduce((n, t) => n + Math.max(1, t.text.length), 0) || tokens.length;
    let cursor = t0;
    for (let k = 0; k < tokens.length; k++) {
      const idx = runStart + k;
      const dur = (span * Math.max(1, tokens[k].text.length)) / totalChars;
      const end =
        k === tokens.length - 1 ? t0 + span : Math.min(t0 + span, cursor + dur);
      starts[idx] = cursor;
      ends[idx] = Math.max(cursor + 0.02, end);
      cursor = ends[idx];
    }
  }

  // Ensure monotonic non-decreasing starts (guard float wobble).
  for (let r = 1; r < reference.length; r++) {
    if (starts[r] < starts[r - 1]) starts[r] = starts[r - 1];
    if (ends[r] < starts[r] + 0.02) ends[r] = starts[r] + 0.02;
  }

  return reference.map((tok, idx) => ({
    id: idx,
    text: tok.text,
    start: starts[idx],
    end: ends[idx],
    speaker: tok.speaker,
    deleted: false,
  }));
}
