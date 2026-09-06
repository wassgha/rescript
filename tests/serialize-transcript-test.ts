/**
 * Unit tests for transcript / subtitle export (and round-trips).
 * Run: npx tsx tests/serialize-transcript-test.ts
 */
import { parseTranscript } from "../lib/parseTranscript";
import {
  formatSrtTimestamp,
  formatTranscriptTimestamp,
  formatVttTimestamp,
  serializeTranscript,
  serializeTranscriptBinary,
} from "../lib/serializeTranscript";
import type { Word } from "../lib/types";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function near(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) <= eps;
}

const sample: Word[] = [
  { id: 0, text: "Hello", start: 1, end: 1.4, speaker: 0, deleted: false },
  { id: 1, text: "world", start: 1.4, end: 2, speaker: 0, deleted: false },
  { id: 2, text: "um", start: 2.1, end: 2.3, speaker: 0, deleted: true },
  { id: 3, text: "How", start: 3.5, end: 3.8, speaker: 1, deleted: false },
  { id: 4, text: "are", start: 3.8, end: 4.1, speaker: 1, deleted: false },
  { id: 5, text: "you", start: 4.1, end: 4.5, speaker: 1, deleted: false },
];

{
  assert(formatSrtTimestamp(1) === "00:00:01,000", "srt ts 1s");
  assert(formatSrtTimestamp(3661.5) === "01:01:01,500", "srt ts hh");
  assert(formatVttTimestamp(1.25) === "00:00:01.250", "vtt ts");
  console.log("timestamps: ok");
}

{
  const srt = serializeTranscript(sample, "srt", { duration: 10 });
  assert(srt.includes("1\n"), "srt has cue index");
  assert(srt.includes("00:00:01,000 --> 00:00:02,000"), `srt timing\n${srt}`);
  assert(srt.includes("Speaker 1: Hello world"), `srt speaker label\n${srt}`);
  assert(srt.includes("Speaker 2: How are you"), `srt speaker 2\n${srt}`);
  assert(!srt.includes("um"), "srt omits deleted");
  assert(/Speaker 2:/.test(srt), "srt second speaker present");
  console.log("srt export: ok");
}

{
  const srt = serializeTranscript(sample, "srt", {
    duration: 10,
    speakers: [
      { id: 0, name: "Alice" },
      { id: 1, name: "Bob" },
    ],
  });
  assert(srt.includes("Alice: Hello world"), `named srt\n${srt}`);
  assert(srt.includes("Bob: How are you"), `named srt 2\n${srt}`);
  console.log("srt named speakers: ok");
}

{
  const vtt = serializeTranscript(sample, "vtt", { duration: 10 });
  assert(vtt.startsWith("WEBVTT"), "vtt header");
  assert(vtt.includes("<v Speaker 1>Hello world"), `vtt voice\n${vtt}`);
  assert(vtt.includes("<v Speaker 2>How are you"), `vtt voice 2\n${vtt}`);
  assert(!vtt.includes("um"), "vtt omits deleted");
  console.log("vtt export: ok");
}

{
  const json = serializeTranscript(sample, "json");
  const data = JSON.parse(json);
  assert(Array.isArray(data.words), "json words array");
  assert(data.words.length === 6, "json keeps deleted words");
  assert(data.words[2].deleted === true && data.words[2].text === "um", "json deleted flag");
  assert(data.words[0].speaker === 0, "json speaker");
  assert(Array.isArray(data.speakers), "json speakers list");
  assert(data.speakers[0].name === "Speaker 1", "json default speaker name");
  console.log("json export: ok");
}

{
  const txt = serializeTranscript(sample, "txt", { duration: 10 });
  assert(txt.includes("Speaker 1: Hello world"), `txt speaker 1\n${txt}`);
  assert(txt.includes("Speaker 2: How are you"), `txt speaker 2\n${txt}`);
  assert(!txt.includes("um"), "txt omits deleted");
  console.log("txt export: ok");
}

{
  const md = serializeTranscript(sample, "md", { duration: 10 });
  assert(md.includes("**Speaker 1**"), `md speaker 1\n${md}`);
  assert(md.includes("Hello world"), "md text 1");
  assert(md.includes("**Speaker 2**"), "md speaker 2");
  assert(md.includes("How are you"), "md text 2");
  assert(!md.includes("um"), "md omits deleted");
  console.log("md export: ok");
}

{
  const txt = serializeTranscript(sample, "txt", {
    duration: 10,
    timestamps: true,
  });
  assert(txt.includes("[0:01] Speaker 1: Hello world"), `txt timestamps\n${txt}`);
  assert(txt.includes("[0:03] Speaker 2: How are you"), `txt timestamps 2\n${txt}`);
  console.log("txt timestamps: ok");
}

{
  const md = serializeTranscript(sample, "md", {
    duration: 10,
    timestamps: true,
  });
  assert(md.includes("**[0:01] Speaker 1**"), `md timestamps\n${md}`);
  assert(md.includes("**[0:03] Speaker 2**"), `md timestamps 2\n${md}`);
  console.log("md timestamps: ok");
}

{
  const docx = serializeTranscriptBinary(sample, "docx", { duration: 10 });
  assert(docx[0] === 0x50 && docx[1] === 0x4b, "docx zip magic");
  assert(docx.length > 500, `docx size ${docx.length}`);
  const asText = new TextDecoder().decode(docx);
  assert(asText.includes("word/document.xml"), "docx has document part");
  assert(asText.includes("Speaker 1"), "docx has speaker");
  assert(asText.includes("Hello world"), "docx has text");
  console.log("docx export: ok");
}

{
  const docx = serializeTranscriptBinary(sample, "docx", {
    duration: 10,
    timestamps: true,
  });
  const asText = new TextDecoder().decode(docx);
  assert(asText.includes("[0:01] Speaker 1"), `docx timestamps\n`);
  console.log("docx timestamps: ok");
}

{
  const pdf = serializeTranscriptBinary(sample, "pdf", { duration: 10 });
  const head = new TextDecoder().decode(pdf.slice(0, 8));
  assert(head.startsWith("%PDF-1."), `pdf header ${head}`);
  assert(pdf.length > 400, `pdf size ${pdf.length}`);
  const asText = new TextDecoder().decode(pdf);
  assert(asText.includes("Speaker 1"), "pdf has speaker");
  assert(asText.includes("Hello world"), "pdf has text");
  assert(asText.includes("%%EOF"), "pdf eof");
  console.log("pdf export: ok");
}

{
  assert(formatTranscriptTimestamp(0) === "0:00", "ts zero");
  assert(formatTranscriptTimestamp(65) === "1:05", "ts mm:ss");
  assert(formatTranscriptTimestamp(3661) === "1:01:01", "ts hh:mm:ss");
  console.log("transcript timestamps: ok");
}

{
  // JSON round-trip preserves text, times, speakers, deleted.
  const json = serializeTranscript(sample, "json");
  const { words: back } = parseTranscript(json, "roundtrip.json");
  assert(back.length === sample.length, "json round-trip length");
  for (let i = 0; i < sample.length; i++) {
    assert(back[i].text === sample[i].text, `json rt text ${i}`);
    assert(near(back[i].start, sample[i].start), `json rt start ${i}`);
    assert(near(back[i].end, sample[i].end), `json rt end ${i}`);
    assert(back[i].speaker === sample[i].speaker, `json rt speaker ${i}`);
    assert(back[i].deleted === sample[i].deleted, `json rt deleted ${i}`);
  }
  console.log("json round-trip: ok");
}

{
  // SRT round-trip (no deletes, original timeline) keeps cue text/times/speakers.
  const clean: Word[] = sample
    .filter((w) => !w.deleted)
    .map((w, i) => ({ ...w, id: i }));
  const srt = serializeTranscript(clean, "srt", {
    editedTimeline: false,
    duration: 10,
  });
  const { words: back } = parseTranscript(srt, "roundtrip.srt");
  assert(back.map((w) => w.text).join(" ") === "Hello world How are you", "srt rt text");
  assert(back[0].speaker === 0 && back[2].speaker === 1, "srt rt speakers");
  assert(near(back[0].start, 1), `srt rt start ${back[0].start}`);
  assert(near(back[back.length - 1].end, 4.5), `srt rt end ${back[back.length - 1].end}`);
  console.log("srt round-trip: ok");
}

{
  const clean: Word[] = sample
    .filter((w) => !w.deleted)
    .map((w, i) => ({ ...w, id: i }));
  const vtt = serializeTranscript(clean, "vtt", {
    editedTimeline: false,
    duration: 10,
  });
  const { words: back } = parseTranscript(vtt, "roundtrip.vtt");
  assert(back.map((w) => w.text).join(" ") === "Hello world How are you", "vtt rt text");
  assert(back[0].speaker === 0 && back[2].speaker === 1, "vtt rt speakers");
  console.log("vtt round-trip: ok");
}

{
  let threw = false;
  try {
    serializeTranscript(
      sample.map((w) => ({ ...w, deleted: true })),
      "srt",
      { duration: 10 }
    );
  } catch {
    threw = true;
  }
  assert(threw, "empty kept words should throw");
  console.log("empty export: ok");
}

{
  // Edited timeline remaps times after a cut.
  const words: Word[] = [
    { id: 0, text: "Keep", start: 0, end: 1, speaker: 0, deleted: false },
    { id: 1, text: "Cut", start: 1, end: 2, speaker: 0, deleted: true },
    { id: 2, text: "Later", start: 3, end: 4, speaker: 0, deleted: false },
  ];
  const srt = serializeTranscript(words, "srt", { duration: 5, editedTimeline: true });
  // Cut [1,2) removes 1s; "Later" 3→4 becomes 2→3 on edited timeline.
  // MERGE_GAP is 0.35 — gap from cut end 2 to next word 3 is 1s, so no merge expansion.
  assert(srt.includes("00:00:00,000 --> 00:00:01,000"), `edited first cue\n${srt}`);
  assert(srt.includes("00:00:02,000 --> 00:00:03,000"), `edited second cue\n${srt}`);
  assert(srt.includes("Keep") && srt.includes("Later") && !srt.includes("Cut"), "edited text");
  console.log("edited timeline: ok");
}

{
  // Manual cuts (passed explicitly) omit covered words even when not deleted.
  const words: Word[] = [
    { id: 0, text: "Keep", start: 0, end: 1, speaker: 0, deleted: false },
    { id: 1, text: "Trimmed", start: 1, end: 2, speaker: 0, deleted: false },
    { id: 2, text: "Later", start: 3, end: 4, speaker: 0, deleted: false },
  ];
  const txt = serializeTranscript(words, "txt", {
    duration: 5,
    cuts: [{ start: 1, end: 2 }],
  });
  assert(txt.includes("Keep"), "manual cut keeps first");
  assert(txt.includes("Later"), "manual cut keeps later");
  assert(!txt.includes("Trimmed"), "manual cut omits trimmed word");
  console.log("manual cuts: ok");
}

console.log("ALL SERIALIZE TRANSCRIPT TESTS PASSED");
