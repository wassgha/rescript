import { addManualCut, getCutRanges, isWordCutOut } from "../lib/edits";
import {
  findSilenceCuts,
  findSilenceRanges,
  MIN_SILENCE_DURATION,
  SILENCE_PAD,
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

{
  // Leading + inter-word + trailing silences above the threshold.
  const words = [w(1, 1.0, 1.5), w(2, 3.0, 3.5)];
  const ranges = findSilenceRanges(words, 5.0);
  assert(ranges.length === 3, `expected 3 silences, got ${ranges.length}`);
  // Leading: flush start, pad before speech.
  assert(nearly(ranges[0]!.start, 0) && nearly(ranges[0]!.end, 1.0 - SILENCE_PAD), "leading");
  // Between words: pad both sides.
  assert(
    nearly(ranges[1]!.start, 1.5 + SILENCE_PAD) &&
      nearly(ranges[1]!.end, 3.0 - SILENCE_PAD),
    "between"
  );
  // Trailing: pad after speech, flush end.
  assert(
    nearly(ranges[2]!.start, 3.5 + SILENCE_PAD) && nearly(ranges[2]!.end, 5.0),
    "trailing"
  );
  console.log("leading/between/trailing: ok");
}

{
  // Tiny inter-word gaps must not count as silence.
  const words = [w(1, 0.5, 1.0), w(2, 1.05, 1.5)];
  const ranges = findSilenceRanges(words, 1.5);
  assert(ranges.length === 1, "only leading silence");
  assert(nearly(ranges[0]!.end, 0.5 - SILENCE_PAD), "leading only");
  console.log("short gaps ignored: ok");
}

{
  // A user-lowered threshold (Settings → silence threshold) picks up a gap
  // the built-in default would ignore, and a raised one ignores a gap the
  // default would pick up — the knob actually reaches this function.
  const words = [w(1, 0.5, 1.0), w(2, 1.15, 1.5)]; // 0.15s gap
  const atDefault = findSilenceRanges(words, 1.5);
  assert(atDefault.length === 1, "default threshold ignores the 0.15s gap");
  const lowered = findSilenceRanges(words, 1.5, [], 0.1);
  assert(lowered.length === 2, "a 0.1s threshold catches the 0.15s gap");

  // No leading/trailing gap (word spans the media edges), isolating the one
  // 1.0s inter-word gap.
  const oneGap = [w(1, 0, 1.0), w(2, 2.0, 3.0)];
  assert(
    findSilenceRanges(oneGap, 3.0).length === 1,
    "default 0.3s threshold catches the 1.0s inter-word gap"
  );
  const raised = findSilenceRanges(oneGap, 3.0, [], 1.5);
  assert(raised.length === 0, "a 1.5s threshold ignores that same 1.0s gap");
  console.log("custom threshold reaches findSilenceRanges: ok");
}

{
  // Exactly at the threshold (before pad) should be detected.
  const gap = MIN_SILENCE_DURATION;
  const words = [w(1, 0, 1), w(2, 1 + gap, 2)];
  const ranges = findSilenceRanges(words, 2);
  assert(ranges.length === 1, "threshold silence detected");
  assert(
    nearly(ranges[0]!.start, 1 + SILENCE_PAD) &&
      nearly(ranges[0]!.end, 1 + gap - SILENCE_PAD),
    "padded threshold cut"
  );
  console.log("threshold silence: ok");
}

{
  // Deleted words already cut their span; silence around them is still found,
  // and the already-cut middle is not re-reported.
  const words = [w(1, 0.5, 1.0), w(2, 1.5, 2.0, true), w(3, 3.0, 3.5)];
  const ranges = findSilenceRanges(words, 3.5);
  // Gap 1.0→3.0 minus deleted cut 1.5–2.0 → [1.0,1.5] and [2.0,3.0], each padded.
  assert(ranges.length === 3, `expected leading + 2 remnants, got ${ranges.length}`);
  assert(nearly(ranges[0]!.start, 0) && nearly(ranges[0]!.end, 0.5 - SILENCE_PAD), "leading");
  assert(
    nearly(ranges[1]!.start, 1.0 + SILENCE_PAD) && nearly(ranges[1]!.end, 1.5),
    "before deleted word (flush against existing cut)"
  );
  assert(
    nearly(ranges[2]!.start, 2.0) && nearly(ranges[2]!.end, 3.0 - SILENCE_PAD),
    "after deleted word"
  );
  console.log("around deleted words: ok");
}

{
  // Already-manual-cut silences disappear from the list (button can hide).
  const words = [w(1, 1.0, 1.5), w(2, 3.0, 3.5)];
  const manual: ManualCut[] = [{ id: 1, start: 0, end: 1.0 - SILENCE_PAD }];
  const ranges = findSilenceRanges(words, 5.0, manual);
  assert(ranges.length === 2, `leading already cut; got ${ranges.length}`);
  assert(ranges.every((r) => r.start >= 1.0), "no leading remnant");
  console.log("skips existing manual cuts: ok");
}

{
  // Idempotent: after cutting all detected silences, none remain.
  const words = [w(1, 1.0, 1.5), w(2, 3.0, 3.5)];
  const first = findSilenceRanges(words, 5.0);
  const manual: ManualCut[] = first.map((r, i) => ({
    id: i + 1,
    start: r.start,
    end: r.end,
  }));
  const second = findSilenceRanges(words, 5.0, manual);
  assert(second.length === 0, `expected no remaining silences, got ${second.length}`);
  console.log("idempotent after cut: ok");
}

{
  // A short word between two pauses must survive "Remove silences", and both
  // pauses must stay restorable (the two cuts used to merge across the word).
  const words = [w(1, 0, 1), w(2, 2, 2.15), w(3, 3, 4)];
  let manual: ManualCut[] = [];
  let nextId = 1;
  for (const r of findSilenceRanges(words, 4)) {
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

console.log("ALL SILENCE TESTS PASSED");
