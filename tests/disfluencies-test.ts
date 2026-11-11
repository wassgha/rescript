/**
 * Run: npx tsx tests/disfluencies-test.ts
 */
import {
  DISFLUENCY_PLACEHOLDER,
  MIN_DISFLUENCY_DURATION,
  insertDisfluencyPlaceholders,
  isDisfluencyPlaceholder,
} from "../lib/disfluencies";
import { findFillerWordIds, isFillerWord } from "../lib/fillers";
import { VAD_FRAME_SIZE, VAD_SAMPLE_RATE } from "../lib/vad";
import type { Word } from "../lib/types";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const FRAME_S = VAD_FRAME_SIZE / VAD_SAMPLE_RATE;

function framesFor(ranges: Array<[number, number]>, totalS: number): boolean[] {
  const n = Math.ceil(totalS / FRAME_S);
  const frames = new Array<boolean>(n).fill(false);
  for (const [a, b] of ranges) {
    for (let i = Math.round(a / FRAME_S); i < Math.round(b / FRAME_S); i++) {
      if (i >= 0 && i < n) frames[i] = true;
    }
  }
  return frames;
}

function word(id: number, text: string, start: number, end: number): Word {
  return { id, text, start, end, speaker: 0, deleted: false };
}

{
  assert(isDisfluencyPlaceholder("..."), "exact placeholder");
  assert(isDisfluencyPlaceholder(" ... "), "trimmed placeholder");
  assert(!isDisfluencyPlaceholder("um"), "um is not a placeholder token");
  assert(!isDisfluencyPlaceholder("[*]"), "legacy [*] marker is not used");
  assert(isFillerWord(DISFLUENCY_PLACEHOLDER), "... counts as a filler");
  console.log("placeholder identity: ok");
}

{
  // Continuous speech with a mid gap Whisper skipped → one "..." filler.
  // Words cover 1.0–1.4 and 2.0–2.4; speech runs 1.0–2.4 (includes filled pause).
  const words = [word(0, "Hello", 1.0, 1.4), word(1, "there", 2.0, 2.4)];
  const frames = framesFor([[1.0, 2.4]], 3);
  const out = insertDisfluencyPlaceholders(words, frames, { duration: 3 });
  const placeholders = out.filter((w) => isDisfluencyPlaceholder(w.text));
  assert(placeholders.length === 1, `expected 1 placeholder, got ${placeholders.length}`);
  const p = placeholders[0]!;
  assert(p.text === "...", "placeholder text is ...");
  assert(p.end - p.start >= MIN_DISFLUENCY_DURATION - 1e-3, "placeholder long enough");
  assert(p.start >= 1.4 - 1e-3, "placeholder after Hello");
  assert(p.end <= 2.0 + 1e-3, "placeholder before there");
  assert(out.length === 3, "merged length");
  assert(
    out.map((w) => w.id).join(",") === "0,1,2",
    `ids reindexed: ${out.map((w) => w.id).join(",")}`
  );
  const fillerIds = findFillerWordIds(out);
  assert(fillerIds.length === 1 && fillerIds[0] === p.id, "Remove fillers sees ...");
  console.log("mid-phrase filled pause: ok");
}

{
  // Short uncovered hangover after a word must not become "...".
  const words = [word(0, "Hi", 1.0, 1.5), word(1, "there", 1.7, 2.2)];
  // Speech covers words + 0.15s hangover bridge — under the min duration after trim.
  const frames = framesFor([[1.0, 1.65], [1.7, 2.2]], 3);
  const out = insertDisfluencyPlaceholders(words, frames, { duration: 3 });
  assert(
    out.filter((w) => isDisfluencyPlaceholder(w.text)).length === 0,
    "hangover-sized gaps ignored"
  );
  console.log("hangover ignored: ok");
}

{
  // Pure silence between words is not a disfluency (Shorten silences owns that).
  const words = [word(0, "Hi", 1.0, 1.4), word(1, "there", 2.2, 2.6)];
  const frames = framesFor(
    [
      [1.0, 1.4],
      [2.2, 2.6],
    ],
    3
  );
  const out = insertDisfluencyPlaceholders(words, frames, { duration: 3 });
  assert(out.length === 2, "silence gaps produce no placeholders");
  console.log("silence not placeholder: ok");
}

{
  // Empty frames → no-op (full-audio fallback path).
  const words = [word(0, "Hi", 0, 0.5)];
  const out = insertDisfluencyPlaceholders(words, [], { duration: 1 });
  assert(out === words, "empty frames returns same array");
  console.log("empty frames no-op: ok");
}

{
  // Leading uncovered speech before the first word.
  const words = [word(0, "Hello", 1.5, 2.0)];
  const frames = framesFor([[0.8, 2.0]], 2.5);
  const out = insertDisfluencyPlaceholders(words, frames, { duration: 2.5 });
  const placeholders = out.filter((w) => isDisfluencyPlaceholder(w.text));
  assert(placeholders.length === 1, "leading filled pause");
  assert(placeholders[0]!.end <= 1.5 + 1e-3, "leading ends before first word");
  console.log("leading filled pause: ok");
}

console.log("ALL DISFLUENCY TESTS PASSED");
