/**
 * Playback order: runs, the edit list, time mapping, cut/copy/paste.
 * Run: npx tsx tests/sequence-test.ts
 */

import { getCutRanges, getKeepRanges } from "../lib/edits";
import {
  activeWordId,
  buildSequence,
  canMove,
  displayTime,
  editedTime,
  editedTimeInRun,
  editList,
  fromDisplay,
  pasteClipboard,
  pieceAtOrAfter,
  playheadPiece,
  snapshotSelection,
  withSourceRanks,
} from "../lib/sequence";
import type { ManualCut, SourceCopy, TimeRange, Word } from "../lib/types";

/** Edited time as the editor computed it before playback order existed. */
function legacyEditedTime(t: number, cuts: TimeRange[]): number {
  let removed = 0;
  for (const cut of cuts) {
    if (t >= cut.end) removed += cut.end - cut.start;
    else if (t > cut.start) removed += t - cut.start;
  }
  return Math.max(0, t - removed);
}

/** Active word as the editor found it before playback order existed. */
function legacyActiveWordId(words: Word[], timeS: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= timeS) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx >= 0 && timeS < words[idx].end + 0.15) return words[idx].id;
  return -1;
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function word(id: number, start: number, end: number, deleted = false): Word {
  return { id, text: `w${id}`, start, end, speaker: 0, deleted };
}

function near(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

function sameRanges(a: TimeRange[], b: TimeRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.start === b[i].start && r.end === b[i].end);
}

function fmt(r: TimeRange[]): string {
  return r.map((x) => `[${x.start},${x.end}]`).join("");
}

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomProject(rand: () => number, duration: number) {
  const words: Word[] = [];
  let t = rand() * 2;
  let id = 1;
  while (t < duration - 0.5) {
    const len = 0.05 + rand() * 0.6;
    words.push(word(id++, t, Math.min(duration, t + len), rand() < 0.3));
    t += len + rand() * (rand() < 0.2 ? 1.5 : 0.3);
  }
  const manualCuts: ManualCut[] = [];
  for (let i = 0; i < 3; i++) {
    if (rand() < 0.5) continue;
    const s = rand() * duration;
    manualCuts.push({ id: i + 1, start: s, end: Math.min(duration, s + rand() * 2) });
  }
  return { words, manualCuts };
}

// 1. Invariant: an array that was never reordered plays exactly today's keeps —
//    sorted transcripts, unsorted imports, jittered timings, words past the end.
{
  const rand = rng(7);
  for (let n = 0; n < 400; n++) {
    const duration = 5 + rand() * 60;
    const { words, manualCuts } = randomProject(rand, duration);
    // Shuffle a little: imports are taken in file order, overlaps happen.
    if (n % 3 === 1) {
      for (let k = 0; k < 3 && words.length > 2; k++) {
        const i = Math.floor(rand() * (words.length - 1));
        [words[i], words[i + 1]] = [words[i + 1], words[i]];
      }
    }
    if (n % 5 === 2) words.push(word(9999, duration + 3, duration + 4));
    const legacy = getKeepRanges(getCutRanges(words, duration, manualCuts), duration);
    const seq = buildSequence(words, manualCuts, [], duration);
    assert(seq.runs.length === 1, `case ${n}: one run (got ${seq.runs.length})`);
    assert(
      sameRanges(editList(seq), legacy),
      `case ${n}: edit list ${fmt(editList(seq))} !== keeps ${fmt(legacy)}`
    );
    // Explicit ranks matching the array keep it identical too.
    const ranked = withSourceRanks(words);
    assert(
      sameRanges(editList(buildSequence(ranked, manualCuts, [], duration)), legacy),
      `case ${n}: ranked words keep the same edit list`
    );
    const cuts = getCutRanges(words, duration, manualCuts);
    for (const w of words) {
      assert(
        near(editedTime(seq, 0, w.start), legacyEditedTime(w.start, cuts), 1e-9),
        `case ${n}: edited time of word ${w.id}`
      );
    }
    if (n % 4 === 0) {
      for (let k = 0; k < 20; k++) {
        const t = rand() * duration;
        assert(
          activeWordId(seq, words, 0, t) === legacyActiveWordId(words, t),
          `case ${n}: active word at ${t}`
        );
      }
    }
  }
  console.log("unreordered invariant (400 random projects): ok");
}

// 2. No words: the whole file plays; manual cuts still apply.
{
  const seq = buildSequence([], [{ id: 1, start: 2, end: 3 }], [], 10);
  assert(
    fmt(editList(seq)) === "[0,2][3,10]",
    `wordless project plays the file minus cuts: ${fmt(editList(seq))}`
  );
  console.log("empty transcript: ok");
}

// 3. Ownership never escapes the copy range (words past the end of the media).
{
  const words = [word(1, 1, 2), word(2, 20, 21)];
  const seq = buildSequence(words, [], [], 10);
  for (const o of seq.owned) {
    assert(o.start >= 0 && o.end <= 10 && o.end >= o.start, `owned span ${o.start}-${o.end} in range`);
  }
  console.log("out-of-range words: ok");
}

// 4. Moving words: the moved block plays where it is placed, pauses and all.
//    A: 0-1 "a" gap "b" 2-3 gap "c" 4-5, duration 6. Gap midpoints: 1.5, 3.5.
{
  const a = word(1, 0.5, 1);
  const b = word(2, 2, 3);
  const c = word(3, 4, 5);
  const ranked = withSourceRanks([a, b, c]);
  const reordered = [ranked[2], ranked[0], ranked[1]]; // c a b
  const seq = buildSequence(reordered, [], [], 6);
  assert(seq.runs.length === 2, `two runs (got ${seq.runs.length})`);
  assert(
    fmt(editList(seq)) === "[3.5,6][0,3.5]",
    `c (with its lead-in and tail) then a b: ${fmt(editList(seq))}`
  );
  assert(near(seq.editedDuration, 6), "nothing lost");
  assert(near(editedTime(seq, 0, 4), 0.5), "c starts 0.5 s into the edit");
  assert(near(editedTime(seq, 0, 0.5), 3), "a starts after c's 2.5 s");
  assert(near(displayTime(seq, 0, 2.5), 2.5 + 2.5), "display axis follows playback");
  const back = fromDisplay(seq, 5);
  assert(back.copy === 0 && near(back.time, 2.5), "display → source");
  assert(activeWordId(seq, reordered, 0, 4.5) === 3, "active word inside the moved run");
  assert(activeWordId(seq, reordered, 0, 2.5) === 2, "active word in the other run");
  console.log("move: ok");
}

// 5. Cuts are computed in source order no matter where the words play:
//    deleted A, kept B, deleted C merge across B (gap < MERGE_GAP) even if a
//    moved run is pasted between them.
{
  const words = withSourceRanks([
    word(1, 1, 2, true),
    word(2, 2.05, 2.1),
    word(3, 2.15, 3, true),
    word(4, 5, 6),
  ]);
  const before = editList(buildSequence(words, [], [], 7));
  const moved = [words[0], words[3], words[1], words[2]];
  const after = buildSequence(moved, [], [], 7);
  const keptB = after.pieces.some((p) => p.start <= 2.05 && p.end >= 2.1);
  assert(!keptB, `B stays merged into the cut after reordering: ${fmt(editList(after))}`);
  assert(near(after.editedDuration, buildSequence(words, [], [], 7).editedDuration), "same kept total");
  void before;
  console.log("source-order cuts: ok");
}

// 6. Copy + paste duplicates; deleting inside the copy leaves the original.
{
  const words = [word(1, 0, 1), word(2, 1.2, 2), word(3, 3, 4)];
  const state = { words, manualCuts: [] as ManualCut[], sceneBoundaries: [], copies: [] as SourceCopy[] };
  const clip = snapshotSelection(words, [], [], [], 5, [2], "copy");
  assert(!!clip && clip.entries.length === 1, "one clipboard entry");
  assert(near(clip!.entries[0].start, 1.1) && near(clip!.entries[0].end, 2.5), "entry owns 1.1–2.5");
  const pasted = pasteClipboard(state, clip!, 3, 5);
  assert(!pasted.moved, "copy pastes a duplicate");
  const w = pasted.state.words;
  assert(w.length === 4 && w[3].copy === 1 && w[3].id === 4, "duplicate appended with a fresh id in copy 1");
  assert(pasted.state.copies.length === 1, "one new copy");
  const seq = buildSequence(w, [], pasted.state.copies, 5);
  assert(fmt(editList(seq)) === "[0,5][1.1,2.5]", `original then the duplicate: ${fmt(editList(seq))}`);
  assert(near(seq.editedDuration, 6.4), "edited duration includes the copy");
  // Delete the duplicate's only word: the copy vanishes, the original stays.
  const del = w.map((x) => (x.id === 4 ? { ...x, deleted: true } : x));
  const seq2 = buildSequence(del, [], pasted.state.copies, 5);
  assert(fmt(editList(seq2)) === "[0,5]", `deleted duplicate is gone: ${fmt(editList(seq2))}`);
  // Same source time, two occurrences: each maps to its own run.
  assert(activeWordId(seq, w, 1, 1.5) === 4, "duplicate's word is active in copy 1");
  assert(activeWordId(seq, w, 0, 1.5) === 2, "original's word is active in copy 0");
  assert(near(editedTime(seq, 1, 1.2), 5.1), "copy plays after the original");
  console.log("duplicate: ok");
}

// 7. Cut then paste moves (and restores the pre-cut deleted flags); a second
//    paste, or a stale clipboard, duplicates instead.
{
  const words = [word(1, 0, 1), word(2, 1.2, 2, true), word(3, 2.2, 3), word(4, 4, 5)];
  const clip = snapshotSelection(words, [], [], [], 6, [2, 3], "cut")!;
  const afterCut = words.map((w) => (w.id === 2 || w.id === 3 ? { ...w, deleted: true } : w));
  assert(canMove(clip, afterCut), "fresh cut can move");
  const state = { words: afterCut, manualCuts: [] as ManualCut[], sceneBoundaries: [], copies: [] as SourceCopy[] };
  const moved = pasteClipboard(state, clip, 0, 6);
  assert(moved.moved, "first paste moves");
  const ids = moved.state.words.map((w) => w.id).join(",");
  assert(ids === "2,3,1,4", `moved to the front: ${ids}`);
  assert(moved.state.words[0].deleted && !moved.state.words[1].deleted, "pre-cut deleted flags restored");
  clip.consumed = true;
  assert(!canMove(clip, moved.state.words), "consumed clipboard no longer moves");
  const again = pasteClipboard(moved.state, clip, 4, 6);
  assert(!again.moved && again.state.words.length === 6, "second paste duplicates");
  // Correcting a cut word invalidates the move: paste duplicates the snapshot.
  const fresh = snapshotSelection(words, [], [], [], 6, [3], "cut")!;
  const corrected = afterCut.map((w) => (w.id === 3 ? { ...w, id: 99, text: "fixed" } : w));
  assert(!canMove(fresh, corrected), "stale cut cannot move");
  console.log("cut/paste move: ok");
}

// 8. Pasting into the middle of a run splits it; the hole a move leaves closes.
{
  const words = withSourceRanks([word(1, 0, 1), word(2, 2, 3), word(3, 4, 5), word(4, 6, 7)]);
  const clip = snapshotSelection(words, [], [], [], 8, [4], "copy")!;
  const pasted = pasteClipboard({ words, manualCuts: [], sceneBoundaries: [], copies: [] }, clip, 2, 8);
  const seq = buildSequence(pasted.state.words, [], pasted.state.copies, 8);
  assert(seq.runs.length === 3, `original split around the paste: ${seq.runs.length} runs`);
  assert(fmt(editList(seq)) === "[0,3.5][5.5,8][3.5,8]", `split edit list: ${fmt(editList(seq))}`);
  console.log("paste splits a run: ok");
}

// 9. Manual cuts and splits travel with a duplicate; cuts stay per copy.
{
  const words = [word(1, 0, 1), word(2, 2, 3), word(3, 4, 5)];
  const manualCuts: ManualCut[] = [{ id: 1, start: 2.2, end: 2.4 }];
  const clip = snapshotSelection(words, manualCuts, [{ id: 1, time: 2.5 }], [], 6, [2], "copy")!;
  assert(clip.entries[0].manualCuts.length === 1, "manual cut captured");
  assert(clip.entries[0].sceneBoundaries.length === 1, "split captured");
  const pasted = pasteClipboard(
    { words, manualCuts, sceneBoundaries: [{ id: 1, time: 2.5 }], copies: [] },
    clip,
    3,
    6
  );
  assert(pasted.state.manualCuts.length === 2 && pasted.state.manualCuts[1].copy === 1, "cut cloned into the copy");
  assert(pasted.state.sceneBoundaries.some((b) => b.copy === 1), "split cloned into the copy");
  const seq = buildSequence(pasted.state.words, pasted.state.manualCuts, pasted.state.copies, 6);
  assert(fmt(editList(seq)) === "[0,2.2][2.4,6][1.5,2.2][2.4,3.5]", `copy keeps its trim: ${fmt(editList(seq))}`);
  // Restoring the copy's cut alone must not touch the original.
  const onlyOriginal = buildSequence(pasted.state.words, [manualCuts[0]], pasted.state.copies, 6);
  assert(fmt(editList(onlyOriginal)) === "[0,2.2][2.4,6][1.5,3.5]", `per-copy cuts: ${fmt(editList(onlyOriginal))}`);
  console.log("per-copy cuts and splits: ok");
}

// 10. Playback walks the pieces in order, resolving cut positions forward.
{
  const words = withSourceRanks([word(1, 0, 1), word(2, 2, 3, true), word(3, 4, 5)]);
  const seq = buildSequence([words[2], words[0], words[1]], [], [], 6);
  // Pieces: run0 = w3 [3.5,6]; run1 = w1 [0,1.5] + w2 deleted [2,3]? cut from 2 to 3
  const p = pieceAtOrAfter(seq, 0, 2.5);
  assert(p >= 0 && seq.pieces[p].start >= 3 - 1e-9, "inside a cut → the next kept piece");
  assert(pieceAtOrAfter(seq, 0, 5.99) === 0, "inside the first piece");
  assert(pieceAtOrAfter(seq, 0, 3.4) === seq.pieces.length - 1, "tail of the last run");
  console.log("transport lookup: ok");
}

// 11. A run edge is two moments: the end of one run and the start of another.
//     Words with no gaps, A B C, played B A C: B ends at 2, which is also C's start.
{
  const words = withSourceRanks([word(1, 0, 1), word(2, 1, 2), word(3, 2, 3)]);
  const order = [words[1], words[0], words[2]]; // B A C
  const seq = buildSequence(order, [], [], 3);
  assert(fmt(editList(seq)) === "[1,2][0,1][2,3]", `B A C: ${fmt(editList(seq))}`);
  const b = 0;
  assert(seq.pieces[b].start === 1 && seq.pieces[b].end === 2, "piece 0 is B");
  // Playing B and reaching its end: the hint keeps us in B, so playback moves on to A.
  assert(playheadPiece(seq, 0, 2, b) === b, "hint holds B at its end");
  assert(playheadPiece(seq, 0, 2.02, b) === b, "and through a frame of overshoot");
  assert(playheadPiece(seq, 0, 2.9, b) === b, "and through a long stall (the player moves on from it)");
  // Without the hint, source time 2 reads as C's start.
  assert(seq.pieces[playheadPiece(seq, 0, 2, null)].start === 2, "no hint: C");
  // A's end maps through A's own run: edited 2, not B's 0.
  const runA = seq.runOf[1];
  assert(near(editedTimeInRun(seq, runA, 0), 1) && near(editedTimeInRun(seq, runA, 1), 2), "A spans edited 1–2");
  console.log("run edges: ok");
}

// 12. A fully cut run between two pieces that continue each other in the media:
//     A B C played A C B with C deleted. The pieces stay apart (each in its run);
//     only the export list joins them.
{
  const words = withSourceRanks([word(1, 0, 1), word(2, 1, 2), word(3, 2, 3, true)]);
  const seq = buildSequence([words[0], words[2], words[1]], [], [], 3);
  assert(seq.pieces.length === 2 && seq.pieces[1].run === 2, "B keeps its own run");
  assert(fmt(editList(seq)) === "[0,2]", `export joins A and B: ${fmt(editList(seq))}`);
  const p = pieceAtOrAfter(seq, 0, 1.5);
  assert(p === 1, `1.5 s is in B's piece (got ${p})`);
  assert(near(editedTime(seq, 0, 1.5), 1.5), "edited time inside B");
  assert(near(displayTime(seq, 0, 1.5), 1 + 1 + 0.5), "B drawn after C's cut");
  console.log("cut run between pieces: ok");
}

console.log("ALL SEQUENCE TESTS PASSED");
