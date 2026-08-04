/**
 * Unit tests for NLE timeline export (XML / FCPXML / AAF).
 * Run: npx tsx tests/serialize-timeline-test.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import {
  buildNleTimeline,
  mediaFileUrl,
  serializeTimelineXml,
} from "../lib/serializeTimeline";
import {
  AAF_MAX_CLIPS,
  aafMediaFileUrl,
  fitAafMediaName,
  secondsToFrames,
  writeAafComposition,
} from "../lib/aaf/patchAaf";

// Node 18+ has fetch; polyfill scaffold loading from disk for AAF tests.
const scaffoldPath = resolve("assets/aaf/scaffold.aaf");
const scaffoldBuf = readFileSync(scaffoldPath);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("scaffold.aaf")) {
    return new Response(scaffoldBuf, { status: 200 });
  }
  return realFetch(input);
}) as typeof fetch;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const keeps = [
  { start: 0, end: 1 },
  { start: 2, end: 3.5 },
];

async function main() {
{
  const width = "RESCRIPT_MEDIA_PLACEHOLDER".length;
  assert(fitAafMediaName("a.mp4").length === width, "fit pads");
  assert(fitAafMediaName("a".repeat(40)).length === width, "fit truncates");
  const longNamed = fitAafMediaName("My Long Interview Recording Final.mp4");
  assert(longNamed.length === width, "long name width");
  assert(longNamed.trimEnd().endsWith(".mp4"), "long name keeps extension");
  assert(
    !fitAafMediaName("short.wav").includes("\0"),
    "padded name has no nulls"
  );
  assert(mediaFileUrl("clip.mp4").startsWith("file:///"), "file url");
  assert(
    mediaFileUrl("clip.mp4", true).startsWith("file://localhost/"),
    "resolve url"
  );
  assert(
    mediaFileUrl("my clip.mp4").includes("my%20clip.mp4"),
    "xml url encodes spaces"
  );
  assert(
    aafMediaFileUrl("my clip.mp4") === "file:///my%20clip.mp4",
    "aaf url encodes spaces"
  );
  assert(secondsToFrames(1, "30") === 30, "30fps frames");
  assert(secondsToFrames(1, "25") === 25, "25fps frames");
  console.log("helpers: ok");
}

{
  const timeline = buildNleTimeline({
    keepRanges: keeps,
    duration: 5,
    mediaFileName: "interview.mp4",
    frameRate: "30",
    withVideo: true,
    withAudio: true,
  });
  assert(timeline.tracks.length === 2, "v+a tracks");
  assert(timeline.tracks[0].items.length === 2, "two video clips");
  assert(timeline.tracks[1].items.length === 2, "two audio clips");
  console.log("build timeline: ok");
}

{
  const premiere = serializeTimelineXml(
    {
      keepRanges: keeps,
      duration: 5,
      mediaFileName: "interview.mp4",
      frameRate: "24",
      withVideo: true,
      withAudio: true,
    },
    "premiere"
  );
  assert(premiere.includes("<xmeml"), "premiere xmeml root");
  assert(premiere.includes("<sequence"), "premiere sequence");
  assert(premiere.includes("interview.mp4"), "premiere media name");
  assert(premiere.includes("<clipitem"), "premiere clipitems");
  console.log("premiere xml: ok");
}

{
  const resolve = serializeTimelineXml(
    {
      keepRanges: keeps,
      duration: 5,
      mediaFileName: "interview.mp4",
      frameRate: "24",
      withVideo: true,
      withAudio: true,
    },
    "resolve"
  );
  assert(resolve.includes("<xmeml"), "resolve xmeml");
  assert(resolve.includes("file://localhost/"), "resolve localhost url");
  console.log("resolve xml: ok");
}

{
  const fcpx = serializeTimelineXml(
    {
      keepRanges: keeps,
      duration: 5,
      mediaFileName: "interview.mp4",
      frameRate: "25",
      withVideo: true,
      withAudio: true,
    },
    "fcpx"
  );
  assert(fcpx.includes("<fcpxml"), "fcpxml root");
  assert(fcpx.includes("<spine>") || fcpx.includes("<spine "), "fcpxml spine");
  assert(fcpx.includes("asset-clip") || fcpx.includes("asset"), "fcpxml assets");
  console.log("fcpxml: ok");
}

{
  // Audio-only timeline
  const xml = serializeTimelineXml(
    {
      keepRanges: keeps,
      duration: 5,
      mediaFileName: "podcast.m4a",
      frameRate: "30",
      withVideo: false,
      withAudio: true,
    },
    "premiere"
  );
  assert(xml.includes("<audio>"), "audio track present");
  console.log("audio-only xml: ok");
}

{
  const blob = await writeAafComposition({
    keepRanges: keeps,
    duration: 5,
    mediaFileName: "interview.mp4",
    frameRate: "30",
    withVideo: true,
    withAudio: true,
  });
  assert(blob.size > 100_000, `aaf size ${blob.size}`);
  const buf = Buffer.from(await blob.arrayBuffer());
  // Compound File magic / CFB signature often starts with D0 CF 11 E0
  assert(buf[0] === 0xd0 && buf[1] === 0xcf, "cfb magic");
  assert(buf.includes(Buffer.from("interview.mp4", "utf16le")), "aaf has filename");
  assert(
    buf.includes(Buffer.from("file:///interview.mp4", "utf16le")),
    "aaf has encoded-safe url"
  );
  writeFileSync("/tmp/rescript-test.aaf", buf);
  console.log("aaf write: ok");
}

{
  const spaced = await writeAafComposition({
    keepRanges: keeps,
    duration: 5,
    mediaFileName: "my clip.mp4",
    frameRate: "24",
    withVideo: true,
    withAudio: true,
  });
  const spacedBuf = Buffer.from(await spaced.arrayBuffer());
  assert(
    spacedBuf.includes(Buffer.from("file:///my%20clip.mp4", "utf16le")),
    "aaf encodes spaces in locator url"
  );
  console.log("aaf url encoding: ok");
}

{
  const tooMany = Array.from({ length: AAF_MAX_CLIPS + 1 }, (_, i) => ({
    start: i,
    end: i + 0.5,
  }));
  let threw = false;
  try {
    await writeAafComposition({
      keepRanges: tooMany,
      duration: AAF_MAX_CLIPS + 2,
      mediaFileName: "interview.mp4",
      frameRate: "30",
      withVideo: true,
      withAudio: true,
    });
  } catch (err) {
    threw = err instanceof Error && err.message.includes(String(AAF_MAX_CLIPS));
  }
  assert(threw, "aaf rejects >64 clips");
  console.log("aaf clip cap: ok");
}

// Validate with pyaaf2 when available (optional — skip if not installed).
{
  const { spawnSync } = await import("child_process");
  const probe = spawnSync(
    "python3",
    ["-c", "import aaf2"],
    { encoding: "utf8" }
  );
  if (probe.status !== 0) {
    console.warn("SKIP: pyaaf2 not installed; AAF round-trip check skipped");
  } else {
    const py = spawnSync(
      "python3",
      [
        "-c",
        `
import aaf2, sys
with aaf2.open("/tmp/rescript-test.aaf", "r") as f:
    tops = list(f.content.toplevel())
    assert len(tops) == 1, tops
    comp = tops[0]
    slots = list(comp.slots)
    assert len(slots) == 2, len(slots)
    for slot in slots:
        comps = list(slot.segment.components)
        assert len(comps) == 2, len(comps)
        assert comps[0].length == 30, comps[0].length
        assert comps[1].start == 60, comps[1].start
        assert comps[1].length == 45, comps[1].length
print("pyaaf2: ok")
`,
      ],
      { encoding: "utf8" }
    );
    if (py.status !== 0) {
      console.error(py.stdout, py.stderr);
      throw new Error("pyaaf2 validation failed");
    }
    process.stdout.write(py.stdout);
  }
}

console.log("ALL SERIALIZE TIMELINE TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
