/**
 * Unit tests for the screen-reader transcript text and caret → word mapping.
 * Run: npx tsx tests/transcript-text-test.ts
 */
import {
  buildTranscriptText,
  wordIdAtCaret,
  wordIdForDelete,
  wordIdsInRange,
  wordStartOffset,
} from "../lib/transcriptText";
import { groupWordsBySpeaker } from "../lib/transcript";
import type { Word } from "../lib/types";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function w(id: number, text: string, speaker: number): Word {
  return { id, text, start: id, end: id + 0.5, speaker, deleted: false };
}

const words = [w(1, "Hello", 0), w(2, "there", 0), w(3, "...", 0), w(4, "Hi", 1)];
const { text, segments } = buildTranscriptText(
  groupWordsBySpeaker(words),
  (id) => `S${id + 1}`,
  (t) => (t === "..." ? "[hesitation]" : t)
);

assert(text === "S1: Hello there [hesitation]\nS2: Hi", `text: ${JSON.stringify(text)}`);
for (const seg of segments) {
  const word = words.find((x) => x.id === seg.id)!;
  const expected = word.text === "..." ? "[hesitation]" : word.text;
  assert(text.slice(seg.start, seg.end) === expected, `segment ${seg.id} offsets`);
}

const hello = segments[0];
const there = segments[1];
const hi = segments[3];

// Selection maps to every word it touches, partial overlaps included.
assert(wordIdsInRange(segments, hello.start + 2, there.start + 1).join() === "1,2", "partial range");
assert(wordIdsInRange(segments, 0, text.length).join() === "1,2,3,4", "select all");
assert(wordIdsInRange(segments, 5, 5).length === 0, "collapsed range is empty");
assert(wordIdsInRange(segments, 0, hello.start).length === 0, "speaker prefix only");

// Caret word: inside, at an edge, in the speaker prefix, past the end.
assert(wordIdAtCaret(segments, hello.start + 1) === 1, "caret inside word");
assert(wordIdAtCaret(segments, there.end) === 2, "caret at word end");
assert(wordIdAtCaret(segments, 1) === 1, "caret in prefix → next word");
assert(wordIdAtCaret(segments, hi.start - 2) === 4, "caret in second prefix → next word");
assert(wordIdAtCaret([], 0) === null, "no words");

// Backspace / Delete from a collapsed caret.
assert(wordIdForDelete(segments, hello.start + 2, "backward") === 1, "backspace inside word");
assert(wordIdForDelete(segments, there.start, "backward") === 1, "backspace at word start → previous");
assert(wordIdForDelete(segments, there.start, "forward") === 2, "delete at word start → this word");
assert(wordIdForDelete(segments, there.end, "backward") === 2, "backspace at word end → this word");
assert(wordIdForDelete(segments, hi.start, "backward") === 3, "backspace across speaker line");
assert(wordIdForDelete(segments, 0, "backward") === null, "backspace at start");
assert(wordIdForDelete(segments, text.length, "forward") === null, "delete at end");

assert(wordStartOffset(segments, 4) === hi.start, "start offset");
assert(wordStartOffset(segments, 99) === null, "missing word");

console.log("transcript-text tests passed");
