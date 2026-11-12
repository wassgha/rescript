import { addManualCut, getCutRanges, isWordCutOut } from "../lib/edits";
import {
  findSilenceCuts,
  findSilenceRanges,
  DEFAULT_SILENCE_LENGTH,
  DEFAULT_SILENCE_SPLIT,
  MIN_SILENCE_TRIM,
  normalizeSilenceLength,
  normalizeSilenceSplit,
  SILENCE_LENGTH_RANGE,
  silenceKeep,
} from "../lib/silences";
import type { ManualCut, Word } from "../lib/types";

function nearly(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) < eps;
}

function w(
  id: number,
  start: number,
  end: number,
  deleted = false
): Word {
  return { id, text: `w${id}`, start, end, speaker: 0, deleted };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Defaults: 0.3s silences, 0.2s kept after the previous word, 0.1s before the next.
const { after: AFTER, before: BEFORE } = silenceKeep(DEFAULT_SILENCE_LENGTH, DEFAULT_SILENCE_SPLIT);
assert(AFTER === 0.2 && BEFORE === 0.1, `default keeps 0.2s + 0.1s, got ${AFTER} + ${BEFORE}`);

/** Seconds of silence left between `from` and `to` once `cuts` are removed. */
function leftBetween(from: number, to: number, cuts: { start: number; end: number }[]): number {
  let left = to - from;
  for (const c of cuts) left -= Math.max(0, Math.min(to, c.end) - Math.max(from, c.start));
  return left;
}

{
  // Leading + inter-word + trailing silences.
  const words = [w(1, 1.0, 1.5), w(2, 3.0, 3.5)];
  const ranges = findSilenceRanges(words, 5.0);
  assert(ranges.length === 3, `expected 3 silences, got ${ranges.length}`);
  // Leading: flush start, the "before word" part stays.
  assert(nearly(ranges[0]!.start, 0) && nearly(ranges[0]!.end, 1.0 - BEFORE), "leading");
  // Between words: after-word part, then before-word part.
  assert(
    nearly(ranges[1]!.start, 1.5 + AFTER) && nearly(ranges[1]!.end, 3.0 - BEFORE),
    "between"
  );
  // Trailing: the "after word" part stays, flush end.
  assert(nearly(ranges[2]!.start, 3.5 + AFTER) && nearly(ranges[2]!.end, 5.0), "trailing");
  console.log("leading/between/trailing: ok");
}

{
  // Gaps no longer than the length stay.
  const words = [w(1, 0.5, 1.0), w(2, 1.05, 1.5)];
  const ranges = findSilenceRanges(words, 1.5);
  assert(ranges.length === 1, "only leading silence");
  assert(nearly(ranges[0]!.end, 0.5 - BEFORE), "leading only");
  console.log("short gaps ignored: ok");
}

{
  // No jump at the length: a silence just over it is shortened to exactly it,
  // and trims too small to hear are skipped.
  const L = DEFAULT_SILENCE_LENGTH;
  const at = (gap: number) => findSilenceRanges([w(1, 0, 1), w(2, 1 + gap, 3)], 3);
  assert(at(L).length === 0, "silence of exactly the length stays");
  assert(at(L + MIN_SILENCE_TRIM / 2).length === 0, "inaudible trim skipped");
  for (const gap of [L + MIN_SILENCE_TRIM, 0.31 + 0.1, 0.8, 2.5]) {
    const ranges = at(gap);
    assert(ranges.length === 1, `${gap}s silence shortened`);
    assert(nearly(leftBetween(1, 1 + gap, ranges), L), `${gap}s silence plays for ${L}s`);
  }
  console.log("shortened to the length: ok");
}

{
  // Deleted words already cut their span; silence around them is still found,
  // and the already-cut middle is not re-reported.
  const words = [w(1, 0.5, 1.0), w(2, 1.5, 2.0, true), w(3, 3.0, 3.5)];
  const ranges = findSilenceRanges(words, 3.5);
  // Gap 1.0→3.0 minus deleted cut 1.5–2.0 → [1.0,1.5] and [2.0,3.0].
  assert(ranges.length === 3, `expected leading + 2 remnants, got ${ranges.length}`);
  assert(nearly(ranges[0]!.start, 0) && nearly(ranges[0]!.end, 0.5 - BEFORE), "leading");
  assert(
    nearly(ranges[1]!.start, 1.0 + AFTER) && nearly(ranges[1]!.end, 1.5),
    "before deleted word (flush against existing cut)"
  );
  assert(
    nearly(ranges[2]!.start, 2.0) && nearly(ranges[2]!.end, 3.0 - BEFORE),
    "after deleted word"
  );
  console.log("around deleted words: ok");
}

{
  // Already-manual-cut silences disappear from the list.
  const words = [w(1, 1.0, 1.5), w(2, 3.0, 3.5)];
  const manual: ManualCut[] = [{ id: 1, start: 0, end: 1.0 - BEFORE }];
  const ranges = findSilenceRanges(words, 5.0, manual);
  assert(ranges.length === 2, `leading already cut; got ${ranges.length}`);
  assert(ranges.every((r) => r.start >= 1.0), "no leading remnant");
  console.log("skips existing manual cuts: ok");
}

{
  // Idempotent: after cutting all detected silences, none remain. A shorter
  // length afterwards shortens what is left to about the new length.
  const words = [w(1, 1.0, 1.5), w(2, 3.0, 3.5)];
  const toCuts = (ranges: { start: number; end: number }[], from: ManualCut[] = []) =>
    [...from, ...ranges.map((r, i) => ({ id: from.length + i + 1, start: r.start, end: r.end }))];
  const manual = toCuts(findSilenceRanges(words, 5.0));
  assert(findSilenceRanges(words, 5.0, manual).length === 0, "nothing left at the same settings");
  const shorter = findSilenceRanges(words, 5.0, manual, 0.2, 0.5);
  const all = toCuts(shorter, manual);
  // 0.2s → 0.1s after the word is trimmed; 0.1s before it already fits.
  assert(nearly(leftBetween(1.5, 3.0, all), 0.2), "re-shortened to 0.2s");
  assert(findSilenceRanges(words, 5.0, all, 0.2, 0.5).length === 0, "idempotent at 0.2s");
  console.log("idempotent after cut: ok");
}

{
  // A short word between two silences must survive, and both silences must
  // stay restorable (the two cuts used to merge across the word).
  const words = [w(1, 0, 1), w(2, 2, 2.15), w(3, 3, 4)];
  let manual: ManualCut[] = [];
  let nextId = 1;
  for (const r of findSilenceRanges(words, 4, [], DEFAULT_SILENCE_LENGTH, 0)) {
    const added = addManualCut(manual, r.start, r.end, nextId);
    manual = added.cuts;
    nextId = added.nextId;
  }
  assert(manual.length === 2, `expected 2 silence cuts, got ${manual.length}`);
  const cuts = getCutRanges(words, 4, manual);
  assert(!isWordCutOut(words[1]!, cuts), "short word stays in the edit");
  assert(findSilenceCuts(words, manual).length === 2, "both silences restorable");
  console.log("short word between silences: ok");
}

{
  // A longer length leaves more silences alone.
  const words = [w(1, 0, 1), w(2, 1.4, 2), w(3, 2.8, 3), w(4, 5, 6)];
  const count = (length: number) => findSilenceRanges(words, 6, [], length).length;
  assert(count(0.3) === 3, `0.3s: expected 3, got ${count(0.3)}`);
  assert(count(0.5) === 2, `0.5s: expected 2, got ${count(0.5)}`);
  assert(count(1) === 1, `1s: expected 1, got ${count(1)}`);
  assert(count(1.9) === 1, `1.9s: 2s silence still trimmed, got ${count(1.9)}`);
  assert(count(2) === 0, `2s: silence of exactly 2s stays, got ${count(2)}`);
  console.log("silence length: ok");
}

{
  // The split decides where the kept silence sits.
  const words = [w(1, 0, 1), w(2, 2, 3)];
  const cut = (split: number) => findSilenceRanges(words, 3, [], 0.4, split)[0]!;
  assert(nearly(cut(0.5).start, 1.2) && nearly(cut(0.5).end, 1.8), "even split");
  assert(nearly(cut(0.8).start, 1.32) && nearly(cut(0.8).end, 1.92), "more after the word");
  assert(nearly(cut(0).start, 1) && nearly(cut(0).end, 1.6), "all before the next word");
  assert(nearly(cut(1).start, 1.4) && nearly(cut(1).end, 2), "all after the previous word");
  console.log("after/before split: ok");
}

{
  // Slider values snap to their steps inside the range; junk is rejected.
  const { min, max } = SILENCE_LENGTH_RANGE;
  assert(min <= DEFAULT_SILENCE_LENGTH && DEFAULT_SILENCE_LENGTH <= max, "default inside range");
  assert(normalizeSilenceLength(DEFAULT_SILENCE_LENGTH) === DEFAULT_SILENCE_LENGTH, "default kept");
  assert(normalizeSilenceLength(0.1 + 0.2) === 0.3, "float noise snapped");
  assert(normalizeSilenceLength(0.74) === 0.7, "rounds to step");
  assert(normalizeSilenceLength(0) === min && normalizeSilenceLength(-1) === min, "clamped low");
  assert(normalizeSilenceLength(99) === max, "clamped high");
  assert(normalizeSilenceLength(NaN) === null && normalizeSilenceLength(Infinity) === null, "non-numbers rejected");
  assert(normalizeSilenceSplit(0.2 / 0.3) === 0.6667, "split rounded");
  assert(silenceKeep(0.3, normalizeSilenceSplit(0.2 / 0.3)!).after === 0.2, "rounded split keeps 0.2s");
  assert(normalizeSilenceSplit(-1) === 0 && normalizeSilenceSplit(2) === 1, "split clamped");
  assert(normalizeSilenceSplit(NaN) === null, "split rejects non-numbers");
  // The two kept amounts always add up to the length.
  for (let l = 1; l <= 30; l++) {
    for (let s = 0; s <= 10; s++) {
      const keep = silenceKeep(l / 10, s / 10);
      assert(nearly(keep.after + keep.before, l / 10, 1e-9), `keep ${l / 10}/${s / 10} adds up`);
    }
  }
  console.log("slider values: ok");
}

console.log("ALL SILENCE TESTS PASSED");
