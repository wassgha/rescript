import type {
  ClipSegment,
  ManualCut,
  SceneBoundary,
  TimeRange,
  Word,
} from "./types";

/** Padding (s) applied when merging adjacent deleted words into one cut. */
const MERGE_GAP = 0.35;

/** Minimum kept clip length after a trim (seconds). */
export const MIN_CLIP_DURATION = 0.05;

/** Ignore splits this close to an existing edge (seconds). */
export const SPLIT_EPSILON = 0.04;
/** Tiny seek offset so playhead lands just inside a kept region. */
export const PLAYHEAD_EPSILON_S = 0.001;

/**
 * Compute cut ranges from deleted words only (silence between adjacent deleted
 * words is included). A cut is derived purely from its words' bounds — drag a
 * word's edge in the wordbar to move the cut edge with it.
 */
export function getWordCutRanges(words: Word[], duration: number): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.deleted) continue;
    const start = w.start;
    let end = w.end;
    while (i + 1 < words.length && words[i + 1].deleted) {
      i++;
      end = Math.max(end, words[i].end);
    }
    ranges.push({ start, end });
  }
  return mergeCutRanges(ranges, duration);
}

/** Merge overlapping / near-adjacent ranges and clamp to [0, duration]. */
export function mergeCutRanges(
  ranges: TimeRange[],
  duration: number,
  gap = MERGE_GAP
): TimeRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges]
    .map((r) => ({
      start: Math.max(0, Math.min(duration, r.start)),
      end: Math.max(0, Math.min(duration, r.end)),
    }))
    .filter((r) => r.end - r.start > 1e-4)
    .sort((a, b) => a.start - b.start);

  const merged: TimeRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < gap) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * All cut ranges: deleted-word spans ∪ manual blade/trim cuts.
 * Manual cuts may be passed as bare TimeRanges or ManualCut objects.
 */
export function getCutRanges(
  words: Word[],
  duration: number,
  manualCuts: Array<TimeRange | ManualCut> = []
): TimeRange[] {
  const fromWords = getWordCutRanges(words, duration);
  const fromManual = manualCuts.map((c) => ({ start: c.start, end: c.end }));
  // Bridge short gaps between cuts, but never across a kept word: a short
  // word between two pauses cut by "Remove silences" has to stay audible.
  const exact = mergeCutRanges([...fromWords, ...fromManual], duration, 1e-4);
  const kept = words.filter((w) => !w.deleted);
  const merged: TimeRange[] = [];
  for (const r of exact) {
    const last = merged[merged.length - 1];
    if (
      last &&
      r.start - last.end < MERGE_GAP &&
      !kept.some((w) => w.end > last.end + 1e-4 && w.start < r.start - 1e-4)
    ) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** Invert cut ranges into the ranges of the original media that remain. */
export function getKeepRanges(cuts: TimeRange[], duration: number): TimeRange[] {
  const keeps: TimeRange[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor + 1e-4) keeps.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < duration - 1e-4) keeps.push({ start: cursor, end: duration });
  return keeps;
}

/**
 * Subdivide keep ranges by scene boundaries into selectable clip segments.
 * Boundaries that fall inside a cut are ignored for geometry.
 */
export function getClipSegments(
  keepRanges: TimeRange[],
  sceneBoundaries: SceneBoundary[]
): ClipSegment[] {
  const times = sceneBoundaries
    .map((b) => b.time)
    .sort((a, b) => a - b);

  const clips: ClipSegment[] = [];
  for (const keep of keepRanges) {
    const splits = times.filter(
      (t) => t > keep.start + SPLIT_EPSILON && t < keep.end - SPLIT_EPSILON
    );
    let cursor = keep.start;
    for (const t of splits) {
      clips.push({
        id: `c-${cursor.toFixed(4)}-${t.toFixed(4)}`,
        start: cursor,
        end: t,
        index: clips.length,
      });
      cursor = t;
    }
    clips.push({
      id: `c-${cursor.toFixed(4)}-${keep.end.toFixed(4)}`,
      start: cursor,
      end: keep.end,
      index: clips.length,
    });
  }
  return clips;
}

/**
 * Scene boundaries that actually divide two touching clips — the ones worth
 * showing a split marker for. A boundary sitting at the edge of a skipped region
 * is inert: the gap already separates the clips, and its own edges are what you
 * would drag. Matches the filter getClipSegments applies.
 */
export function getActiveSceneBoundaries(
  boundaries: SceneBoundary[],
  keepRanges: TimeRange[]
): SceneBoundary[] {
  return boundaries.filter((b) =>
    keepRanges.some(
      (k) => b.time > k.start + SPLIT_EPSILON && b.time < k.end - SPLIT_EPSILON
    )
  );
}

/**
 * Place each split in the transcript: the word it reads as sitting in front of.
 * Returns wordId → boundary. A split landing mid-word snaps to the nearer side so
 * the marker always falls in a gap between words; one in trailing silence has no
 * word to anchor to and is left out (the timeline still shows it).
 */
export function mapSplitsToWords(
  words: Word[],
  boundaries: SceneBoundary[]
): Map<number, SceneBoundary> {
  const map = new Map<number, SceneBoundary>();
  for (const b of boundaries) {
    let i = words.findIndex((w) => w.start >= b.time);
    if (i === -1) i = words.length;
    const prev = words[i - 1];
    if (prev && b.time < prev.end && b.time < (prev.start + prev.end) / 2) i -= 1;
    if (i < words.length) map.set(words[i].id, b);
  }
  return map;
}

/** Duration of the edited video (sum of kept ranges). */
export function getEditedDuration(cuts: TimeRange[], duration: number): number {
  const cut = cuts.reduce((acc, r) => acc + (r.end - r.start), 0);
  return Math.max(0, duration - cut);
}

/** Map a time in original media to the corresponding time in the edited cut. */
export function originalToEdited(t: number, cuts: TimeRange[]): number {
  let removed = 0;
  for (const cut of cuts) {
    if (t >= cut.end) removed += cut.end - cut.start;
    else if (t > cut.start) removed += t - cut.start;
  }
  return Math.max(0, t - removed);
}

/** Find the cut range containing time t, if any. */
export function cutRangeAt(t: number, cuts: TimeRange[]): TimeRange | null {
  for (const cut of cuts) {
    if (t >= cut.start && t < cut.end) return cut;
  }
  return null;
}

/**
 * Whether a word is fully removed from the edited media: either explicitly
 * deleted, or entirely covered by an effective cut (e.g. a blade/trim cut).
 */
export function isWordCutOut(word: Word, cuts: TimeRange[]): boolean {
  if (word.deleted) return true;
  if (word.end - word.start <= 1e-4) return false;
  for (const c of cuts) {
    if (word.start >= c.start - 1e-4 && word.end <= c.end + 1e-4) return true;
  }
  return false;
}

/** Mark words whose full span lies inside [from, to) as deleted. */
export function deleteWordsCoveredBy(
  words: Word[],
  from: number,
  to: number
): Word[] {
  if (to <= from) return words;
  let changed = false;
  const next = words.map((w) => {
    if (w.deleted) return w;
    if (w.start >= from - 1e-4 && w.end <= to + 1e-4) {
      changed = true;
      return { ...w, deleted: true };
    }
    return w;
  });
  return changed ? next : words;
}

/** Restore deleted words whose full span lies inside [from, to). */
export function restoreWordsCoveredBy(
  words: Word[],
  from: number,
  to: number
): Word[] {
  if (to <= from) return words;
  let changed = false;
  const next = words.map((w) => {
    if (!w.deleted) return w;
    if (w.start >= from - 1e-4 && w.end <= to + 1e-4) {
      changed = true;
      return { ...w, deleted: false };
    }
    return w;
  });
  return changed ? next : words;
}

/** Find the clip containing time t, if any. */
export function clipAt(t: number, clips: ClipSegment[]): ClipSegment | null {
  for (const c of clips) {
    if (t >= c.start && t < c.end) return c;
    // Include exact end of last clip / exact start
    if (t === c.end && Math.abs(c.end - c.start) > 0) {
      // Prefer matching start of next; fall through
    }
  }
  // Exact end of media: last clip
  for (let i = clips.length - 1; i >= 0; i--) {
    if (t === clips[i].end) return clips[i];
  }
  return null;
}

/**
 * Whether a split is allowed at time t (inside a keep region, not too close
 * to existing edges or scene boundaries).
 */
export function canSplitAt(
  t: number,
  duration: number,
  cuts: TimeRange[],
  sceneBoundaries: SceneBoundary[]
): boolean {
  if (t <= SPLIT_EPSILON || t >= duration - SPLIT_EPSILON) return false;
  if (cutRangeAt(t, cuts)) return false;
  for (const cut of cuts) {
    if (Math.abs(t - cut.start) < SPLIT_EPSILON || Math.abs(t - cut.end) < SPLIT_EPSILON) {
      return false;
    }
  }
  for (const b of sceneBoundaries) {
    if (Math.abs(t - b.time) < SPLIT_EPSILON) return false;
  }
  return true;
}

/**
 * Clamp a word's new bounds against neighbors.
 * Returns updated start/end; may steal time from adjacent words when expanding.
 */
export function clampWordBounds(
  words: Word[],
  index: number,
  nextStart: number,
  nextEnd: number,
  duration: number
): { start: number; end: number; neighborPatches: Array<{ index: number; start?: number; end?: number }> } {
  const w = words[index];
  const minDur = 0.02;
  let start = Math.max(0, Math.min(nextStart, nextEnd - minDur));
  let end = Math.min(duration, Math.max(nextEnd, start + minDur));

  const patches: Array<{ index: number; start?: number; end?: number }> = [];

  const prev = index > 0 ? words[index - 1] : null;
  const next = index < words.length - 1 ? words[index + 1] : null;

  // Hard floor: don't cross into previous word's start
  if (prev) {
    const floor = prev.start + minDur;
    if (start < floor) start = floor;
    // If we expand left into prev, shrink prev.end
    if (start < prev.end) {
      patches.push({ index: index - 1, end: start });
    }
  }

  if (next) {
    const ceil = next.end - minDur;
    if (end > ceil) end = ceil;
    if (end > next.start) {
      patches.push({ index: index + 1, start: end });
    }
  }

  if (end - start < minDur) {
    end = start + minDur;
  }

  // Re-apply if patches would make neighbor invalid — prefer keeping this word's intent
  void w;
  return { start, end, neighborPatches: patches };
}

/**
 * Apply word-bound drag: returns a new words array with the target (and
 * possibly neighbors) updated.
 */
export function applyWordBounds(
  words: Word[],
  wordId: number,
  nextStart: number,
  nextEnd: number,
  duration: number
): Word[] | null {
  const index = words.findIndex((w) => w.id === wordId);
  if (index < 0) return null;
  const { start, end, neighborPatches } = clampWordBounds(
    words,
    index,
    nextStart,
    nextEnd,
    duration
  );
  const cur = words[index];
  if (Math.abs(cur.start - start) < 1e-4 && Math.abs(cur.end - end) < 1e-4 && neighborPatches.length === 0) {
    return null;
  }
  const next = words.map((w) => ({ ...w }));
  next[index] = { ...next[index], start, end };
  for (const p of neighborPatches) {
    next[p.index] = {
      ...next[p.index],
      ...(p.start !== undefined ? { start: p.start } : {}),
      ...(p.end !== undefined ? { end: p.end } : {}),
    };
  }
  return next;
}

/**
 * Shrink or remove manual cuts overlapping [from, to).
 * When a cut is split into two remnants, `nextId` supplies fresh ids.
 */
export function shrinkManualCuts(
  manualCuts: ManualCut[],
  from: number,
  to: number,
  nextId = 1_000_000
): { cuts: ManualCut[]; nextId: number } {
  if (to <= from) return { cuts: manualCuts, nextId };
  const out: ManualCut[] = [];
  let id = nextId;
  for (const c of manualCuts) {
    if (c.end <= from || c.start >= to) {
      out.push(c);
      continue;
    }
    if (c.start >= from && c.end <= to) continue;
    if (c.start < from && c.end > to) {
      out.push({ ...c, end: from });
      out.push({ id: id++, start: to, end: c.end });
      continue;
    }
    if (c.start < from) {
      out.push({ ...c, end: from });
      continue;
    }
    if (c.end > to) {
      out.push({ ...c, start: to });
    }
  }
  return { cuts: out, nextId: id };
}

/** Add a manual cut and merge with existing ones that touch. */
export function addManualCut(
  manualCuts: ManualCut[],
  start: number,
  end: number,
  nextId: number
): { cuts: ManualCut[]; nextId: number } {
  if (end - start < 1e-4) return { cuts: manualCuts, nextId };
  const merged = mergeCutRanges(
    [...manualCuts.map((c) => ({ start: c.start, end: c.end })), { start, end }],
    Number.POSITIVE_INFINITY,
    1e-4
  );
  // Rebuild with stable-ish ids: keep old ids when a merged range covers an old cut's midpoint
  let id = nextId;
  const cuts: ManualCut[] = merged.map((r) => {
    const existing = manualCuts.find(
      (c) => c.start >= r.start - 1e-4 && c.end <= r.end + 1e-4
    );
    if (existing) return { id: existing.id, start: r.start, end: r.end };
    return { id: id++, start: r.start, end: r.end };
  });
  return { cuts, nextId: id };
}

/**
 * Range a trim drag may move one clip edge through: from shrinking the clip to
 * MIN_CLIP_DURATION, out to fully reclaiming the adjacent gap — but never past
 * it, since beyond the gap lies the neighbouring clip's own edge.
 */
export function trimEdgeBounds(
  clip: ClipSegment,
  edge: "in" | "out",
  cuts: TimeRange[]
): { lo: number; hi: number } {
  const eps = 1e-3;
  const gap = cuts.find((c) =>
    edge === "in"
      ? Math.abs(c.end - clip.start) < eps
      : Math.abs(c.start - clip.end) < eps
  );
  const lo =
    edge === "in" ? (gap ? gap.start : clip.start) : clip.start + MIN_CLIP_DURATION;
  const hi =
    edge === "in" ? clip.end - MIN_CLIP_DURATION : gap ? gap.end : clip.end;
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}

/**
 * Carry a split point that sits exactly on a dragged edge along with it.
 * A boundary left behind at the old position keeps splitting the keep range once
 * the edge moves past it, which slices the reclaimed span off into its own
 * orphan clip instead of letting it join the clip being trimmed.
 */
export function carrySceneBoundaries(
  boundaries: SceneBoundary[],
  from: number,
  to: number
): SceneBoundary[] {
  if (!boundaries.some((b) => Math.abs(b.time - from) < SPLIT_EPSILON)) {
    return boundaries;
  }
  const moved = boundaries
    .map((b) => (Math.abs(b.time - from) < SPLIT_EPSILON ? { ...b, time: to } : b))
    .sort((a, b) => a.time - b.time);

  // Closing a gap completely can land two split points on top of each other.
  const out: SceneBoundary[] = [];
  for (const b of moved) {
    const last = out[out.length - 1];
    if (last && b.time - last.time < SPLIT_EPSILON) continue;
    out.push(b);
  }
  return out;
}

/**
 * Restore media in the given cut ranges: shrink overlapping manual cuts and
 * undelete words fully covered by each range. Inverse of cutting a clip / silence.
 */
export function restoreRangesResult(
  words: Word[],
  manualCuts: ManualCut[],
  ranges: TimeRange[],
  nextCutId: number
): { words: Word[]; manualCuts: ManualCut[]; nextCutId: number } | null {
  const usable = ranges.filter((r) => r.end - r.start > 1e-4);
  if (usable.length === 0) return null;

  let nextWords = words;
  let cuts = manualCuts;
  let id = nextCutId;
  let changed = false;

  for (const r of usable) {
    const shrunk = shrinkManualCuts(cuts, r.start, r.end, id);
    const restored = restoreWordsCoveredBy(nextWords, r.start, r.end);
    if (shrunk.cuts !== cuts || restored !== nextWords) changed = true;
    cuts = shrunk.cuts;
    id = shrunk.nextId;
    nextWords = restored;
  }

  if (!changed) return null;
  return { words: nextWords, manualCuts: cuts, nextCutId: id };
}

/**
 * Move one kept-region edge from `from` to `to`. `edge` names the side that
 * stays kept ("out" = the clip left of the edge, "in" = the clip right of it),
 * which is what decides whether the move cuts the span away or reclaims it.
 * Edges are addressed by time rather than by clip index because a trim can merge
 * or split clips — and renumber them — while the drag is still in progress.
 */
export function trimEdgeResult(
  words: Word[],
  manualCuts: ManualCut[],
  edge: "in" | "out",
  from: number,
  to: number,
  nextCutId: number
): { words: Word[]; manualCuts: ManualCut[]; nextCutId: number } | null {
  if (Math.abs(to - from) < 1e-4) return null;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const cutting = edge === "out" ? to < from : to > from;

  if (cutting) {
    const { cuts, nextId } = addManualCut(manualCuts, lo, hi, nextCutId);
    return {
      words: deleteWordsCoveredBy(words, lo, hi),
      manualCuts: cuts,
      nextCutId: nextId,
    };
  }
  const { cuts, nextId } = shrinkManualCuts(manualCuts, lo, hi, nextCutId);
  return {
    words: restoreWordsCoveredBy(words, lo, hi),
    manualCuts: cuts,
    nextCutId: nextId,
  };
}

/** Format seconds as m:ss.d (or h:mm:ss for long media). */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`;
  }
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}
