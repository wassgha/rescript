/**
 * Unit tests for SRT / VTT / JSON / plain-text transcript import + sync align.
 * Run: npx tsx scripts/parse-transcript-test.ts
 */
import { alignTranscript } from "../lib/alignTranscript";
import { parseTranscript } from "../lib/parseTranscript";
import type { Word } from "../lib/types";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

{
  const parsed = parseTranscript(
    `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:04,500 --> 00:00:06,000
Alice: How are you?
`,
    "sample.srt"
  );
  assert(parsed.kind === "timed", "srt is timed");
  if (parsed.kind !== "timed") throw new Error("unreachable");
  const words = parsed.words;
  assert(words.length === 5, `srt expected 5 words, got ${words.length}`);
  assert(words[0].text === "Hello", "srt first word");
  assert(words[0].start === 1, `srt start ${words[0].start}`);
  assert(words[1].text === "world", "srt second word");
  assert(Math.abs(words[1].end - 3) < 1e-6, "srt cue end on last token");
  assert(words[2].text === "How", "srt speaker label stripped");
  assert(words[2].speaker === 0, "srt Name: maps to speaker 0");
  console.log("srt: ok");
}

{
  const parsed = parseTranscript(
    `WEBVTT

00:00:00.000 --> 00:00:02.000
<v Ned>Winter is coming

00:00:02.500 --> 00:00:04.000
<v Catelyn>You know nothing
`,
    "sample.vtt"
  );
  assert(parsed.kind === "timed", "vtt is timed");
  if (parsed.kind !== "timed") throw new Error("unreachable");
  const words = parsed.words;
  assert(words.length === 6, `vtt expected 6 words, got ${words.length}`);
  assert(words[0].speaker === 0 && words[0].text === "Winter", "vtt voice 0");
  assert(words[3].speaker === 1 && words[3].text === "You", "vtt voice 1");
  console.log("vtt: ok");
}

{
  const parsed = parseTranscript(
    JSON.stringify({
      words: [
        { text: "One", start: 0, end: 0.4, speaker: "A" },
        { text: "Two", start: 0.4, end: 0.8, speaker: "B" },
      ],
    }),
    "sample.json"
  );
  assert(parsed.kind === "timed", "json is timed");
  if (parsed.kind !== "timed") throw new Error("unreachable");
  assert(parsed.words.length === 2, "json length");
  assert(
    parsed.words[0].speaker === 0 && parsed.words[1].speaker === 1,
    "json speakers"
  );
  console.log("json: ok");
}

{
  const parsed = parseTranscript(
    `Alice: Hello there, friend.
Bob: Hi Alice — how are you?
`,
    "script.txt"
  );
  assert(parsed.kind === "untimed", "txt is untimed");
  if (parsed.kind !== "untimed") throw new Error("unreachable");
  assert(parsed.tokens.length === 9, `txt tokens ${parsed.tokens.length}`);
  assert(parsed.tokens[0].text === "Hello", "txt strips speaker label");
  assert(parsed.tokens[0].speaker === 0, "Alice → speaker 0");
  assert(parsed.tokens[3].text === "Hi", "Bob line");
  assert(parsed.tokens[3].speaker === 1, "Bob → speaker 1");
  console.log("txt: ok");
}

{
  let threw = false;
  try {
    parseTranscript("   ", "empty.srt");
  } catch {
    threw = true;
  }
  assert(threw, "empty should throw");
  console.log("empty: ok");
}

{
  const asr: Word[] = [
    { id: 0, text: "hello", start: 0.0, end: 0.4, speaker: 0, deleted: false },
    { id: 1, text: "there", start: 0.4, end: 0.8, speaker: 0, deleted: false },
    { id: 2, text: "friend", start: 0.9, end: 1.3, speaker: 0, deleted: false },
  ];
  const aligned = alignTranscript(
    [
      { text: "Hello,", speaker: 0 },
      { text: "there", speaker: 0 },
      { text: "friend!", speaker: 1 },
    ],
    asr,
    2
  );
  assert(aligned.length === 3, "align length");
  assert(aligned[0].text === "Hello,", "keeps reference spelling");
  assert(aligned[0].start === 0, "matched start");
  assert(aligned[2].speaker === 1, "reference speaker wins");
  assert(aligned[2].end > aligned[2].start, "positive duration");
  console.log("align: ok");
}

{
  // Extra reference word gets interpolated between anchors.
  const asr: Word[] = [
    { id: 0, text: "one", start: 0, end: 0.3, speaker: 0, deleted: false },
    { id: 1, text: "three", start: 1.0, end: 1.4, speaker: 0, deleted: false },
  ];
  const aligned = alignTranscript(
    [
      { text: "one", speaker: 0 },
      { text: "two", speaker: 0 },
      { text: "three", speaker: 0 },
    ],
    asr
  );
  assert(aligned[1].text === "two", "interpolated token");
  assert(aligned[1].start >= aligned[0].end - 1e-6, "monotonic");
  assert(aligned[1].end <= aligned[2].start + 1e-6, "before next");
  console.log("align interpolate: ok");
}

console.log("ALL PARSE TRANSCRIPT TESTS PASSED");
