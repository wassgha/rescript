/**
 * Unit tests for NLE timeline export (XML / FCPXML / AAF).
 * Run: npx tsx tests/serialize-timeline-test.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import {
  buildNleTimeline,
  mediaFileUrl,
  serializeReaperRpp,
  serializeSamplitudeEdl,
  serializeTimelineXml,
  stripFcpxmlModDate,
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
  // FCP fails DTD validation on an unparseable modDate, so we omit it.
  assert(!fcpx.includes("modDate"), "fcpxml has no modDate");
  // V1/A1 are the same media over the same ranges; a single asset-clip per
  // range carries both, so no duplicate connected clips in lane 1.
  assert(!fcpx.includes("lane="), "fcpxml has no connected-clip lanes");
  assert(
    fcpx.match(/<asset-clip/g)?.length === keeps.length,
    "one fcpxml asset-clip per keep range"
  );
  console.log("fcpxml: ok");
}

{
  // Audio-only projects have a single track and must still land on the spine.
  const fcpx = serializeTimelineXml(
    {
      keepRanges: keeps,
      duration: 5,
      mediaFileName: "podcast.m4a",
      frameRate: "30",
      withVideo: false,
      withAudio: true,
    },
    "fcpx"
  );
  assert(fcpx.includes('hasAudio="1"'), "fcpxml audio-only asset");
  assert(!fcpx.includes('hasVideo="1"'), "fcpxml audio-only has no video");
  assert(
    fcpx.match(/<asset-clip/g)?.length === keeps.length,
    "audio-only fcpxml asset-clips"
  );
  console.log("fcpxml audio-only: ok");
}

{
  assert(
    stripFcpxmlModDate('<project name="a" modDate="2026-01-01 00:00:00 UTC">') ===
      '<project name="a">',
    "strips modDate"
  );
  assert(
    stripFcpxmlModDate('<project modDate="x" uid="u"/>') === '<project uid="u"/>',
    "strips modDate mid-tag"
  );
  // Only the project tag; a clip named "modDate=..." must survive untouched.
  const kept = '<asset-clip name="my modDate=&quot;x&quot; take.mp4"/>';
  assert(stripFcpxmlModDate(kept) === kept, "leaves non-project tags alone");
  console.log("strip modDate: ok");
}

{
  // Premiere/Resolve still need the parallel audio track.
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
  assert(premiere.includes("<video>"), "premiere keeps video track");
  assert(premiere.includes("<audio>"), "premiere keeps audio track");
  console.log("xmeml tracks intact: ok");
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
  const rpp = serializeReaperRpp({
    keepRanges: keeps,
    duration: 5,
    mediaFileName: "interview.mp4",
    projectName: "Interview",
    frameRate: "30",
    withVideo: true,
    withAudio: true,
  });
  assert(rpp.startsWith("<REAPER_PROJECT"), "rpp root");
  assert(rpp.includes('<SOURCE VIDEO'), "rpp video source");
  assert(rpp.includes('FILE "interview.mp4"'), "rpp media file");
  assert(rpp.includes("SOFFS 0"), "rpp first source offset");
  assert(rpp.includes("SOFFS 2"), "rpp second source offset");
  assert(rpp.includes("POSITION 0"), "rpp first position");
  assert(rpp.includes("POSITION 1"), "rpp second position after 1s clip");
  assert(rpp.includes("LENGTH 1.5"), "rpp second length");
  console.log("reaper rpp: ok");
}

{
  const rpp = serializeReaperRpp({
    keepRanges: keeps,
    duration: 5,
    mediaFileName: "podcast.mp3",
    frameRate: "30",
    withVideo: false,
    withAudio: true,
  });
  assert(rpp.includes("<SOURCE MP3"), "rpp mp3 source");
  console.log("reaper rpp audio: ok");
}

{
  const edl = serializeSamplitudeEdl({
    keepRanges: keeps,
    duration: 5,
    mediaFileName: "interview.mp4",
    projectName: "Interview",
    frameRate: "30",
    withVideo: true,
    withAudio: true,
    audioRate: 48000,
  });
  assert(edl.startsWith("Samplitude EDL File Format Version 1.5"), "edl header");
  assert(edl.includes('Title: "Interview"'), "edl title");
  assert(edl.includes("Sample Rate: 48000"), "edl sample rate");
  assert(edl.includes('1 "interview.mp4"'), "edl source table");
  assert(edl.includes("Track 1:"), "edl track");
  // First clip: play 0–48000, record 0–48000
  assert(edl.includes("            0        48000            0        48000"), "edl clip 1 samples");
  // Second clip starts at timeline sample 48000, source at 2s = 96000
  assert(edl.includes("        48000       120000        96000       168000"), "edl clip 2 samples");
  console.log("samplitude edl: ok");
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
