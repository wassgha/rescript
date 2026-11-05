import { getCutRanges, getKeepRanges } from "./edits";
import type {
  CopyRange,
  ManualCut,
  SceneBoundary,
  SourceCopy,
  TimeRange,
  Word,
} from "./types";

/**
 * Playback order on top of source-time edits.
 *
 * The `words` array is the edit in playback order. Every word belongs to a
 * copy — one pass over the media: copy 0 is the original file, a pasted
 * duplicate gets its own copy spanning just what was copied. Within a copy each
 * source word appears once, so cuts are worked out per copy exactly as they
 * always were, in source order. The array order then decides in which order the
 * pieces of each copy play.
 *
 * All of a copy's media is owned by its words: the gap between two words is
 * split at its midpoint, the first word also owns the lead-in from the copy's
 * start and the last one the tail to its end. A *run* is a stretch of the array
 * whose words follow each other in source order within one copy; it covers the
 * media its words own, silences included. Moving words therefore takes the
 * pauses around them along.
 */

/** Copy id of a word, cut or split (absent = the original). */
export function copyOf(item: { copy?: number }): number {
  return item.copy ?? 0;
}

/** A stretch of the array that plays one continuous span of one copy. */
export interface Run extends CopyRange {
  /** Array index of the run's first word (inclusive). */
  from: number;
  /** Array index past the run's last word (exclusive). */
  to: number;
  /** Where the run starts on the display axis (seconds, cut material included). */
  offset: number;
}

/** A kept span of media in playback order — one entry of the edit list. */
export interface Piece extends CopyRange {
  /** Index of the run the piece belongs to. */
  run: number;
  /** Where the piece starts in the edited output (seconds). */
  offset: number;
}

/** A cut, clipped to one run, in display order. */
export interface DisplayCut extends CopyRange {
  run: number;
}

export interface Sequence {
  /** The whole edit in playback order, cut material included. */
  runs: Run[];
  /** What plays, in order. */
  pieces: Piece[];
  /** Effective cuts of each copy, in source time (sorted, merged). */
  cuts: Map<number, TimeRange[]>;
  /** Cuts as laid out on the display axis. */
  displayCuts: DisplayCut[];
  /** Length of the display axis (sum of runs). */
  displayDuration: number;
  /** Length of the edited output (sum of pieces). */
  editedDuration: number;
  /** Each word's owned span, by array index. */
  owned: TimeRange[];
  /** Run index of each word, by array index. */
  runOf: number[];
  /** Run indices of each copy, sorted by source start. */
  runsByCopy: Map<number, number[]>;
}

const EMPTY_CUTS: TimeRange[] = [];

/** Source range a copy covers. */
export function copyRange(
  copy: number,
  copies: SourceCopy[],
  duration: number
): TimeRange {
  if (copy === 0) return { start: 0, end: duration };
  const c = copies.find((x) => x.id === copy);
  if (!c) return { start: 0, end: 0 };
  const start = Math.max(0, Math.min(duration, c.start));
  return { start, end: Math.max(start, Math.min(duration, c.end)) };
}

/**
 * Array indices of each copy's words in source order. The rank is the word's
 * `src`, or its array index while the array has never been reordered.
 */
export function sourceOrder(words: Word[]): Map<number, number[]> {
  const byCopy = new Map<number, number[]>();
  words.forEach((w, i) => {
    const c = copyOf(w);
    const list = byCopy.get(c);
    if (list) list.push(i);
    else byCopy.set(c, [i]);
  });
  for (const list of byCopy.values()) {
    list.sort((a, b) => (words[a].src ?? a) - (words[b].src ?? b) || a - b);
  }
  return byCopy;
}

/** A copy's words in source order. */
export function wordsOfCopy(words: Word[], copy: number): Word[] {
  return (sourceOrder(words).get(copy) ?? []).map((i) => words[i]);
}

/** Items (cuts, splits) that belong to `copy`. */
export function ofCopy<T extends { copy?: number }>(items: T[], copy: number): T[] {
  return items.filter((x) => copyOf(x) === copy);
}

/**
 * Effective cuts of one copy, in source time: deleted words and manual cuts,
 * merged exactly as the editor always has. A duplicate whose words are all
 * deleted is gone entirely — nothing of it is left to play.
 */
export function copyCuts(
  srcWords: Word[],
  manualCuts: ManualCut[],
  copy: number,
  range: TimeRange,
  duration: number
): TimeRange[] {
  if (copy !== 0 && srcWords.length > 0 && srcWords.every((w) => w.deleted)) {
    return range.end - range.start > 1e-4 ? [{ ...range }] : [];
  }
  return getCutRanges(srcWords, duration, ofCopy(manualCuts, copy));
}

export function buildSequence(
  words: Word[],
  manualCuts: ManualCut[],
  copies: SourceCopy[],
  duration: number
): Sequence {
  const order = sourceOrder(words);
  const owned: TimeRange[] = new Array(words.length);
  /** Position of each word in its copy's source order. */
  const pos: number[] = new Array(words.length);
  const cuts = new Map<number, TimeRange[]>();

  for (const [copy, list] of order) {
    const range = copyRange(copy, copies, duration);
    let prev = range.start;
    list.forEach((idx, k) => {
      pos[idx] = k;
      const next = list[k + 1];
      let end = range.end;
      if (next !== undefined) {
        const p = words[idx];
        const q = words[next];
        const mid = Math.min(q.start, Math.max(p.start, (p.end + q.start) / 2));
        end = Math.max(prev, Math.min(range.end, Math.max(range.start, mid)));
      }
      owned[idx] = { start: prev, end };
      prev = end;
    });
    cuts.set(
      copy,
      copyCuts(list.map((i) => words[i]), manualCuts, copy, range, duration)
    );
  }

  const runs: Run[] = [];
  const runOf: number[] = new Array(words.length);
  if (words.length === 0) {
    runs.push({ copy: 0, start: 0, end: Math.max(0, duration), from: 0, to: 0, offset: 0 });
    cuts.set(0, getCutRanges([], duration, ofCopy(manualCuts, 0)));
  }
  words.forEach((w, i) => {
    const c = copyOf(w);
    const last = runs[runs.length - 1];
    if (last && last.to === i && last.copy === c && pos[i] === pos[i - 1] + 1) {
      last.to = i + 1;
      last.end = owned[i].end;
    } else {
      runs.push({ copy: c, start: owned[i].start, end: owned[i].end, from: i, to: i + 1, offset: 0 });
    }
    runOf[i] = runs.length - 1;
  });

  let display = 0;
  let edited = 0;
  const pieces: Piece[] = [];
  const displayCuts: DisplayCut[] = [];
  runs.forEach((run, r) => {
    run.offset = display;
    display += run.end - run.start;
    const runCuts = cuts.get(run.copy) ?? EMPTY_CUTS;
    for (const k of getKeepRanges(runCuts, run.end, run.start)) {
      pieces.push({ copy: run.copy, start: k.start, end: k.end, run: r, offset: edited });
      edited += k.end - k.start;
    }
    for (const c of runCuts) {
      if (c.end <= run.start + 1e-4 || c.start >= run.end - 1e-4) continue;
      displayCuts.push({
        copy: run.copy,
        start: Math.max(c.start, run.start),
        end: Math.min(c.end, run.end),
        run: r,
      });
    }
  });

  const runsByCopy = new Map<number, number[]>();
  runs.forEach((run, r) => {
    const list = runsByCopy.get(run.copy);
    if (list) list.push(r);
    else runsByCopy.set(run.copy, [r]);
  });
  for (const list of runsByCopy.values()) {
    list.sort((a, b) => runs[a].start - runs[b].start);
  }

  return {
    runs,
    pieces,
    cuts,
    displayCuts,
    displayDuration: display,
    editedDuration: edited,
    owned,
    runOf,
    runsByCopy,
  };
}

/** Effective cuts of one copy. */
export function cutsOf(seq: Sequence, copy: number): TimeRange[] {
  return seq.cuts.get(copy) ?? EMPTY_CUTS;
}

/**
 * The edit list: source ranges in playback order. Pieces that continue each
 * other in the media (a fully cut run between them dropped out) are joined.
 */
export function editList(seq: Sequence): TimeRange[] {
  const out: TimeRange[] = [];
  let prev: Piece | null = null;
  for (const p of seq.pieces) {
    const last = out[out.length - 1];
    if (last && prev && prev.copy === p.copy && Math.abs(last.end - p.start) < 1e-9) {
      last.end = p.end;
    } else {
      out.push({ start: p.start, end: p.end });
    }
    prev = p;
  }
  return out;
}

/** Run holding source time `t` of `copy`, or -1. Each point of a copy lies in exactly one run. */
export function runAt(seq: Sequence, copy: number, t: number): number {
  const list = seq.runsByCopy.get(copy);
  if (!list || list.length === 0) return -1;
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (seq.runs[list[mid]].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return list[0];
  return list[found];
}

/** Display-axis position of source time `t` in `copy`. */
export function displayTime(seq: Sequence, copy: number, t: number): number {
  const r = runAt(seq, copy, t);
  if (r < 0) return 0;
  const run = seq.runs[r];
  return run.offset + Math.min(Math.max(t - run.start, 0), run.end - run.start);
}

/** Display position within a given run (for drags confined to their run). */
export function displayTimeInRun(seq: Sequence, r: number, t: number): number {
  const run = seq.runs[r];
  return run.offset + Math.min(Math.max(t - run.start, 0), run.end - run.start);
}

/** Run at a display-axis position. */
function runAtDisplay(seq: Sequence, d: number): number {
  const { runs } = seq;
  let lo = 0;
  let hi = runs.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].offset <= d) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Source position (copy, time) at a display-axis position. */
export function fromDisplay(seq: Sequence, d: number): { copy: number; time: number; run: number } {
  const r = runAtDisplay(seq, d);
  const run = seq.runs[r];
  if (!run) return { copy: 0, time: 0, run: 0 };
  return {
    copy: run.copy,
    time: run.start + Math.min(Math.max(d - run.offset, 0), run.end - run.start),
    run: r,
  };
}

/**
 * The piece that plays at or next after source time `t` of `copy`: the piece
 * containing it, else the first kept piece that follows it in playback.
 * Returns -1 past the end of the edit.
 */
export function pieceAtOrAfter(seq: Sequence, copy: number, t: number): number {
  const r = runAt(seq, copy, t);
  const { pieces } = seq;
  if (r < 0) return pieces.length > 0 ? 0 : -1;
  // Pieces are ordered by run, then by source time within a run.
  let lo = 0;
  let hi = pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = pieces[mid];
    if (p.run < r || (p.run === r && p.end - 1e-6 <= t)) lo = mid + 1;
    else hi = mid;
  }
  return lo < pieces.length ? lo : -1;
}

/** Index of the first piece of run `r` or of a later run. */
function firstPieceOf(seq: Sequence, r: number): number {
  let lo = 0;
  let hi = seq.pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (seq.pieces[mid].run < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Position in the edited output of source time `t` within run `r`. A time in
 * a cut maps to where the output resumes. Give the run when it is known (a
 * word's own run): at a run edge, source time alone can't tell the end of one
 * run from the start of the next.
 */
export function editedTimeInRun(seq: Sequence, r: number, t: number): number {
  const { pieces } = seq;
  let i = firstPieceOf(seq, r);
  for (; i < pieces.length && pieces[i].run === r; i++) {
    const p = pieces[i];
    if (t < p.start) return p.offset;
    if (t <= p.end) return p.offset + (t - p.start);
  }
  if (i < pieces.length) return pieces[i].offset;
  // Past the end of the edit (e.g. an imported word timed beyond the media):
  // keep counting from the end, as source time would.
  const run = seq.runs[r];
  return seq.editedDuration + (run ? Math.max(0, t - run.end) : 0);
}

/** Position in the edited output of source time `t` in `copy`. */
export function editedTime(seq: Sequence, copy: number, t: number): number {
  const r = runAt(seq, copy, t);
  return r < 0 ? 0 : editedTimeInRun(seq, r, t);
}

/**
 * The piece the playhead is in, or -1 past the end. `hint` is the piece
 * playback last reported (cleared by every seek and edit): it wins from its
 * start onwards, however far playback has run past its end, because source
 * time alone can't tell the end of one run from the start of the next — the
 * end of a moved sentence is also where the media after it begins.
 */
export function playheadPiece(
  seq: Sequence,
  copy: number,
  t: number,
  hint: number | null
): number {
  if (hint !== null) {
    const p = seq.pieces[hint];
    if (p && p.copy === copy && t >= p.start - 1e-4) return hint;
  }
  return pieceAtOrAfter(seq, copy, t);
}

/** The run the playhead is in (see playheadPiece). */
export function playheadRun(
  seq: Sequence,
  copy: number,
  t: number,
  hint: number | null
): number {
  if (hint !== null) {
    const p = seq.pieces[hint];
    if (p && p.copy === copy && t >= p.start - 1e-4) return p.run;
  }
  return runAt(seq, copy, t);
}

/**
 * The word being spoken at source time `t` of `copy`, or -1. Looks only inside
 * the run that plays that moment, so a duplicate highlights its own words.
 */
export function activeWordId(
  seq: Sequence,
  words: Word[],
  copy: number,
  t: number,
  r = runAt(seq, copy, t)
): number {
  if (r < 0) return -1;
  const { from, to } = seq.runs[r];
  let lo = from;
  let hi = to - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx >= 0 && t < words[idx].end + 0.15) return words[idx].id;
  return -1;
}

/**
 * Give every word an explicit source rank, unique within its copy, keeping the
 * current source order. Needed before the array is reordered; returns `words`
 * unchanged when the ranks are already explicit and dense.
 */
export function withSourceRanks(words: Word[]): Word[] {
  const order = sourceOrder(words);
  const rank = new Array<number>(words.length);
  for (const list of order.values()) list.forEach((idx, k) => (rank[idx] = k));
  if (words.every((w, i) => w.src === rank[i])) return words;
  return words.map((w, i) => (w.src === rank[i] ? w : { ...w, src: rank[i] }));
}

/** One run's worth of a clipboard: what plays, and the edits that shape it. */
export interface ClipboardEntry {
  copy: number;
  /** Source span the selected words own. */
  start: number;
  end: number;
  /** The words as they were (deleted flags included), in playback order. */
  words: Word[];
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
}

export interface Clipboard {
  mode: "cut" | "copy";
  entries: ClipboardEntry[];
  text: string;
  /** A cut moves its words on the first paste; later pastes duplicate. */
  consumed: boolean;
}

/**
 * Snapshot the selected words for cut / copy. Selected words are grouped by
 * the runs they sit in; each group keeps the span it owns plus the manual cuts
 * and splits inside it, so a pasted duplicate plays exactly like the original.
 */
export function snapshotSelection(
  words: Word[],
  manualCuts: ManualCut[],
  sceneBoundaries: SceneBoundary[],
  copies: SourceCopy[],
  duration: number,
  ids: number[],
  mode: Clipboard["mode"]
): Clipboard | null {
  const idSet = new Set(ids);
  const ranked = withSourceRanks(words);
  const seq = buildSequence(ranked, manualCuts, copies, duration);
  const entries: ClipboardEntry[] = [];
  let open: { entry: ClipboardEntry; run: number; last: number } | null = null;
  ranked.forEach((w, i) => {
    if (!idSet.has(w.id)) return;
    const run = seq.runOf[i];
    if (open && open.run === run && open.last === i - 1) {
      open.entry.words.push(w);
      open.entry.end = seq.owned[i].end;
      open.last = i;
      return;
    }
    const entry: ClipboardEntry = {
      copy: copyOf(w),
      start: seq.owned[i].start,
      end: seq.owned[i].end,
      words: [w],
      manualCuts: [],
      sceneBoundaries: [],
    };
    entries.push(entry);
    open = { entry, run, last: i };
  });
  if (entries.length === 0) return null;
  for (const e of entries) {
    e.manualCuts = ofCopy(manualCuts, e.copy)
      .filter((c) => c.end > e.start + 1e-4 && c.start < e.end - 1e-4)
      .map((c) => ({ ...c, start: Math.max(c.start, e.start), end: Math.min(c.end, e.end) }));
    e.sceneBoundaries = ofCopy(sceneBoundaries, e.copy).filter(
      (b) => b.time > e.start && b.time < e.end
    );
  }
  return {
    mode,
    entries,
    text: entries.flatMap((e) => e.words.map((w) => w.text)).join(" "),
    consumed: false,
  };
}

export interface EditState {
  words: Word[];
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
  copies: SourceCopy[];
}

function nextIdAfter(items: Array<{ id: number }>): number {
  return items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}

/** Whether a cut clipboard can still move its words (they exist, untouched, still cut). */
export function canMove(clipboard: Clipboard, words: Word[]): boolean {
  if (clipboard.mode !== "cut" || clipboard.consumed) return false;
  const byId = new Map(words.map((w) => [w.id, w]));
  return clipboard.entries.every((e) =>
    e.words.every((s) => {
      const w = byId.get(s.id);
      return (
        !!w &&
        w.deleted &&
        copyOf(w) === copyOf(s) &&
        w.start === s.start &&
        w.end === s.end &&
        w.text === s.text
      );
    })
  );
}

/**
 * Paste a clipboard before array index `at` (words.length = at the end).
 * A fresh cut moves its words there and gives them back the deleted state they
 * had before the cut; anything else inserts duplicates — each clipboard entry
 * becomes a new copy with fresh ids.
 */
export function pasteClipboard(
  state: EditState,
  clipboard: Clipboard,
  at: number,
  duration: number
): { state: EditState; moved: boolean; pastedIds: number[] } {
  const words = withSourceRanks(state.words);
  const anchor = words[at]?.id;

  if (canMove(clipboard, words)) {
    const moving = new Map<number, Word>();
    for (const e of clipboard.entries) for (const s of e.words) moving.set(s.id, s);
    const rest = words.filter((w) => !moving.has(w.id));
    const byId = new Map(words.map((w) => [w.id, w]));
    // The anchor may itself be moving: paste before the next word that stays.
    let insert = rest.length;
    if (anchor !== undefined) {
      for (let i = at; i < words.length; i++) {
        if (!moving.has(words[i].id)) {
          insert = rest.findIndex((w) => w.id === words[i].id);
          break;
        }
      }
    }
    const moved = [...moving.values()].map((s) => ({ ...byId.get(s.id)!, deleted: s.deleted }));
    return {
      state: {
        ...state,
        words: [...rest.slice(0, insert), ...moved, ...rest.slice(insert)],
      },
      moved: true,
      pastedIds: moved.map((w) => w.id),
    };
  }

  let wordId = nextIdAfter(words);
  let cutId = nextIdAfter(state.manualCuts);
  let boundaryId = nextIdAfter(state.sceneBoundaries);
  let copyId = nextIdAfter(state.copies);
  const copies = [...state.copies];
  const manualCuts = [...state.manualCuts];
  const sceneBoundaries = [...state.sceneBoundaries];
  const inserted: Word[] = [];
  for (const e of clipboard.entries) {
    const copy = copyId++;
    const start = Math.max(0, Math.min(duration, e.start));
    copies.push({ id: copy, start, end: Math.max(start, Math.min(duration, e.end)) });
    for (const w of e.words) inserted.push({ ...w, id: wordId++, copy });
    for (const c of e.manualCuts) manualCuts.push({ ...c, id: cutId++, copy });
    for (const b of e.sceneBoundaries) sceneBoundaries.push({ ...b, id: boundaryId++, copy });
  }
  sceneBoundaries.sort((a, b) => a.time - b.time);
  const insert = Math.max(0, Math.min(at, words.length));
  return {
    state: {
      words: [...words.slice(0, insert), ...inserted, ...words.slice(insert)],
      manualCuts,
      sceneBoundaries,
      copies,
    },
    moved: false,
    pastedIds: inserted.map((w) => w.id),
  };
}

let cached: {
  words: Word[];
  manualCuts: ManualCut[];
  copies: SourceCopy[];
  duration: number;
  seq: Sequence;
} | null = null;

/**
 * buildSequence for the live edit, reused while its inputs are unchanged —
 * the store replaces these arrays on every edit, so identity is the key.
 */
export function sequenceFor(
  words: Word[],
  manualCuts: ManualCut[],
  copies: SourceCopy[],
  duration: number
): Sequence {
  if (
    cached &&
    cached.words === words &&
    cached.manualCuts === manualCuts &&
    cached.copies === copies &&
    cached.duration === duration
  ) {
    return cached.seq;
  }
  const seq = buildSequence(words, manualCuts, copies, duration);
  cached = { words, manualCuts, copies, duration, seq };
  return seq;
}
