/**
 * Unit tests for Blender (.blend) timeline export and source frame-rate parsing.
 * Run: npx tsx tests/blend-test.ts
 */
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { BlendFile, StructView, truncateUtf8, type BlendBlock } from "../lib/blend/blendFile";
import {
  blenderFps,
  planBlendStrips,
  writeBlendProject,
  type BlendExportInput,
} from "../lib/blend/writeBlend";
import { parseVideoFrameRate } from "../lib/exportArgs";

const scaffold = readFileSync(resolve("assets/blend/scaffold.blend"));
globalThis.fetch = (async (input: RequestInfo | URL) => {
  if (String(input).includes("scaffold.blend")) return new Response(scaffold, { status: 200 });
  throw new Error(`unexpected fetch ${String(input)}`);
}) as typeof fetch;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, msg: string) {
  const json = (v: unknown) =>
    JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  const a = json(actual);
  const e = json(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

async function parse(blob: Blob): Promise<BlendFile> {
  return new BlendFile(await blob.arrayBuffer());
}

function strips(file: BlendFile) {
  const byAddress = file.byAddress();
  const ed = file.blocks.find((b) => b.code === "DATA" && file.typeOf(b) === "Editing")!;
  const out: StructView[] = [];
  let at = new StructView(file.sdna, "Editing", ed).getPointer("seqbase.first");
  let prev = BigInt(0);
  while (at !== BigInt(0)) {
    const block = byAddress.get(at);
    assert(!!block, "strip list points at a saved block");
    const s = new StructView(file.sdna, "Sequence", block!);
    eq(s.getPointer("prev"), prev, "strip prev link");
    out.push(s);
    prev = at;
    at = s.getPointer("next");
  }
  eq(new StructView(file.sdna, "Editing", ed).getPointer("seqbase.last"), prev, "list last");
  return out;
}

/** Every pointer in every DATA block resolves to a saved block (or is null). */
function assertNoDanglingPointers(file: BlendFile, blocks: BlendBlock[]) {
  const byAddress = file.byAddress();
  for (const b of blocks) {
    const type = file.typeOf(b);
    const view = new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength);
    for (const p of file.sdna.pointers(type)) {
      const v = view.getBigUint64(p.offset, true);
      assert(v === BigInt(0) || byAddress.has(v), `${type}.${p.name} dangles`);
    }
  }
}

const base: BlendExportInput = {
  keepRanges: [
    { start: 0, end: 3.412 },
    { start: 4.187, end: 9.903 },
    { start: 11.25, end: 20.071 },
    { start: 22.538, end: 46.866667 },
  ],
  duration: 46.866667,
  mediaFileName: "interview.mp4",
  frameRate: { num: 30, den: 1 },
  withVideo: true,
  withAudio: true,
  width: 1080,
  height: 1920,
};

async function main() {
  // ffmpeg stream lines → frame rate (tbr first; Blender reads the same rate).
  {
    const line = (rates: string) =>
      `  Stream #0:1[0x2](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1080x1920, 15228 kb/s, ${rates}, 600 tbn (default)`;
    eq(parseVideoFrameRate(line("29.97 fps, 30 tbr")), { num: 30, den: 1 }, "VFR phone video uses tbr");
    eq(parseVideoFrameRate(line("23.98 fps, 23.98 tbr")), { num: 24000, den: 1001 }, "23.976");
    eq(parseVideoFrameRate(line("29.97 fps, 29.97 tbr")), { num: 30000, den: 1001 }, "29.97");
    eq(parseVideoFrameRate(line("59.94 fps, 59.94 tbr")), { num: 60000, den: 1001 }, "59.94");
    eq(parseVideoFrameRate(line("25 fps, 25 tbr")), { num: 25, den: 1 }, "25");
    eq(parseVideoFrameRate(line("12.5 fps, 12.5 tbr")), { num: 1250, den: 100 }, "12.5");
    eq(parseVideoFrameRate(line("30 fps")), { num: 30, den: 1 }, "fps without tbr");
    eq(
      parseVideoFrameRate(
        "  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 600x600, 90k tbr, 90k tbn (attached pic)"
      ),
      null,
      "cover art is not video"
    );
    eq(
      parseVideoFrameRate("  Stream #0:0: Audio: aac (LC), 44100 Hz, stereo, fltp, 251 kb/s"),
      null,
      "audio line"
    );
    console.log("frame rate parsing: ok");
  }

  // Frame plan mirrors the render: trim keeps the first frame at or after each
  // ms-rounded cut, concat starts each clip once its longer stream has ended.
  {
    const { clips, frames } = planBlendStrips(base.keepRanges, base.frameRate, 1406, true);
    eq(
      clips.map((c) => [c.sourceIn, c.sourceOut, c.timelineStart, c.holdFrames]),
      [
        [0, 103, 1, 0],
        [126, 298, 104, 0],
        [338, 603, 276, 0],
        [677, 1406, 541, 1],
      ],
      "frames kept and placement"
    );
    // The last keep's audio (729.87 frames) outlasts its 729 frames: the render
    // holds the last frame, so the timeline runs to frame 1270.
    eq(frames, 1270, "timeline length");
    // Audio starts exactly on the cut: frame 126 is at 4.2 s, the cut is 4.187 s.
    assert(Math.abs(clips[1].soundIn - 125.61) < 1e-9, "sound in-point");
    // 3.412 s of audio is 102.36 frames; Blender cuts audio on whole frames, so
    // it stops on frame 102 rather than play the deleted audio after the cut.
    eq(clips[0].soundFrames, 102, "sound stops before the cut-out");
    eq(
      planBlendStrips([{ start: 1.0004, end: 2 }], { num: 30, den: 1 }, 100, true).clips[0].sourceIn,
      30,
      "cut times are rounded to ms like the ffmpeg filter"
    );
    // Each keep holds one frame and 58 ms (1.74 frames) of audio: concat starts
    // the clips 58 ms apart, so they land on frames 1, 3 and 4 with held frames between.
    const short = [
      { start: 0.001, end: 0.059 },
      { start: 1.001, end: 1.059 },
      { start: 2.001, end: 2.059 },
    ];
    const timed = planBlendStrips(short, { num: 30, den: 1 }, 100, true);
    eq(
      timed.clips.map((c) => [c.timelineStart, c.holdFrames, c.soundFrames]),
      [
        [1, 1, 1],
        [3, 0, 1],
        [4, 2, 1],
      ],
      "clips start where concat starts them"
    );
    eq(timed.frames, 6, "timeline covers all the kept audio");
    eq(
      planBlendStrips(short, { num: 30, den: 1 }, 100, false).clips.map((c) => [
        c.timelineStart,
        c.holdFrames,
      ]),
      [
        [1, 0],
        [2, 0],
        [3, 0],
      ],
      "without audio, clips butt up"
    );
    eq(
      planBlendStrips(
        [
          { start: 0, end: 1 },
          { start: 1.01, end: 1.02 },
          { start: 2, end: 3 },
        ],
        { num: 30, den: 1 },
        100,
        true
      ).clips.map((c) => [c.sourceIn, c.sourceOut, c.timelineStart, c.soundFrames]),
      [
        [0, 30, 1, 30],
        [31, 31, 31, 0],
        [60, 90, 31, 30],
      ],
      "a keep holding no frame gets no frame from outside it"
    );
    const audioOnly = planBlendStrips([{ start: 1.001, end: 2.004 }], { num: 1000, den: 1 }, 5000, true);
    eq(
      audioOnly.clips.map((c) => [c.sourceIn, c.sourceOut, c.timelineStart, c.holdFrames, c.soundFrames]),
      [[1001, 2004, 1, 0, 1003]],
      "audio-only cuts land exactly on the 1 ms grid"
    );
    eq(
      planBlendStrips([{ start: 9.9, end: 10.5 }], { num: 30, den: 1 }, 300, false).clips[0].sourceOut,
      300,
      "never past the source's last frame"
    );
    eq(blenderFps({ num: 30000, den: 1001 }), { fps: 30, base: 1.001 }, "NTSC fps");
    eq(blenderFps({ num: 25, den: 1 }), { fps: 25, base: 1 }, "integer fps");
    console.log("frame plan: ok");
  }

  // The scaffold ships in every export: no machine-specific paths in it.
  {
    const text = scaffold.toString("latin1");
    for (const path of ["/home/", "/Users/", ":\\Users\\"]) {
      assert(!text.includes(path), `scaffold.blend contains a local path (${path})`);
    }
    const blob = await writeBlendProject(base);
    const exported = Buffer.from(await blob.arrayBuffer()).toString("latin1");
    for (const path of ["/home/", "/Users/", "ownloads/"]) {
      assert(!exported.includes(path), `export contains a local path (${path})`);
    }
    const file = await parse(blob);
    const dirs = file.blocks
      .filter((b) => b.code === "DATA" && file.typeOf(b) === "Strip")
      .map((b) => new StructView(file.sdna, "Strip", b).getString("dir"));
    eq([...new Set(dirs)], ["//"], "every strip points next to the .blend");
    console.log("no local paths: ok");
  }

  // Video + audio: a movie and a sound strip per keep (plus a hold strip where
  // the render holds a frame), linked by relative path.
  {
    const file = await parse(await writeBlendProject(base));
    const list = strips(file);
    const names = list.map((s) => s.getString("name"));
    eq(new Set(names).size, names.length, "unique strip names");
    assert(!names.some((n) => n.includes("RESCRIPT")), "template strips removed");
    const span = (s: StructView) => [
      s.getInt("type") === 3 ? "movie" : "sound",
      s.getInt("machine"),
      s.getFloat("start") + s.getFloat("startofs"),
      s.getFloat("start") + s.getInt("len") - s.getFloat("endofs"),
    ];
    eq(
      list.map(span),
      [
        ["movie", 2, 1, 104],
        ["sound", 1, 1, 103],
        ["movie", 2, 104, 276],
        ["sound", 1, 104, 275],
        ["movie", 2, 276, 541],
        ["sound", 1, 276, 540],
        ["movie", 2, 541, 1270],
        ["movie", 2, 1270, 1271],
        ["sound", 1, 541, 1270],
      ],
      "strips on the timeline"
    );
    const byAddress = file.byAddress();
    const { clips } = planBlendStrips(base.keepRanges, base.frameRate, 1406, true);
    const sounds = list.filter((s) => s.getInt("type") === 4);
    sounds.forEach((s, i) => {
      // Integer handles (Blender cuts audio on whole frames); the cut lands on the strip's start.
      assert(Number.isInteger(s.getFloat("startofs")), "whole-frame sound handle");
      const playsFrom = s.getFloat("startofs") - s.getFloat("sound_offset") * 30;
      assert(Math.abs(playsFrom - clips[i].soundIn) < 1e-3, "sound starts on the cut");
    });
    const movies = list.filter((s) => s.getInt("type") === 3);
    movies.forEach((s, i) => {
      if (i < 4) eq(s.getFloat("startofs"), clips[i].sourceIn, "source in");
      const strip = new StructView(file.sdna, "Strip", byAddress.get(s.getPointer("strip"))!);
      eq(strip.getString("dir"), "//", "movie dir is the .blend's folder");
      const elem = new StructView(file.sdna, "StripElem", byAddress.get(strip.getPointer("stripdata"))!);
      eq(elem.getString("name"), "interview.mp4", "movie file name");
    });
    // The hold strip's content ends on the clip's last frame, so Blender holds it.
    const hold = list[7];
    eq([hold.getInt("len"), hold.getFloat("startofs"), hold.getFloat("endofs")], [1406, 1405, 0], "hold strip");
    const sound = file.blocks.filter((b) => b.code === "SO");
    eq(sound.length, 1, "one shared sound");
    const so = new StructView(file.sdna, "bSound", sound[0]);
    eq(so.getString("name"), "//interview.mp4", "sound path");
    eq(so.getString("id.name"), "SOinterview.mp4", "sound name");
    const sc = new StructView(file.sdna, "Scene", file.blocks.find((b) => b.code === "SC")!);
    eq([sc.getShort("r.frs_sec"), sc.getFloat("r.frs_sec_base")], [30, 1], "scene fps");
    eq([sc.getInt("r.xsch"), sc.getInt("r.ysch")], [1080, 1920], "resolution");
    eq([sc.getInt("r.sfra"), sc.getInt("r.efra")], [1, 1270], "scene range");
    assertNoDanglingPointers(
      file,
      file.blocks.filter((b) => b.code === "DATA" && file.typeOf(b).startsWith("Strip"))
    );
    assertNoDanglingPointers(
      file,
      file.blocks.filter((b) => b.code === "DATA" && file.typeOf(b) === "Sequence")
    );
    console.log("video + audio project: ok");
  }

  // Audio-only: sound strips on a 1000 fps (1 ms) grid; silent video: no sound datablock.
  {
    const audio = await parse(
      await writeBlendProject({ ...base, withVideo: false, mediaFileName: "talk.mp3" })
    );
    const list = strips(audio);
    eq(list.length, 4, "one sound strip per keep");
    assert(list.every((s) => s.getInt("type") === 4), "sound strips only");
    const sc = new StructView(audio.sdna, "Scene", audio.blocks.find((b) => b.code === "SC")!);
    eq(sc.getShort("r.frs_sec"), 1000, "audio-only 1 ms grid");

    const silent = await parse(await writeBlendProject({ ...base, withAudio: false }));
    eq(strips(silent).length, 4, "one movie strip per keep");
    eq(silent.blocks.filter((b) => b.code === "SO").length, 0, "no sound datablock");
    console.log("audio-only / silent video: ok");
  }

  // NTSC rate, non-ASCII and long names, many clips.
  {
    const name = `${"日本語の長いファイル名".repeat(4)}.mov`;
    const keeps = Array.from({ length: 1000 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.3 }));
    const file = await parse(
      await writeBlendProject({
        ...base,
        keepRanges: keeps,
        duration: 500,
        mediaFileName: name,
        frameRate: { num: 30000, den: 1001 },
      })
    );
    const list = strips(file);
    assert(list.length >= 2000, "a movie and a sound strip per keep");
    assert(
      list.every((s) => new TextEncoder().encode(s.getString("name")).byteLength <= 63),
      "names fit char[64]"
    );
    eq(new Set(list.map((s) => s.getString("name"))).size, list.length, "unique truncated names");
    const sc = new StructView(file.sdna, "Scene", file.blocks.find((b) => b.code === "SC")!);
    assert(Math.abs(sc.getFloat("r.frs_sec_base") - 1.001) < 1e-6, "NTSC base");
    eq(truncateUtf8("aé", 2), "a", "truncate on a character boundary");
    console.log("NTSC / long names / 1000 clips: ok");
  }

  // Rejections.
  {
    const rejects = async (input: BlendExportInput, text: string) => {
      let message = "";
      try {
        await writeBlendProject(input);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assert(message.includes(text), `expected "${text}", got "${message}"`);
    };
    await rejects({ ...base, keepRanges: [] }, "nothing to export");
    await rejects({ ...base, keepRanges: [{ start: 1.01, end: 1.02 }] }, "nothing to export");
    await rejects({ ...base, withVideo: false, withAudio: false }, "Nothing to put");
    await rejects({ ...base, mediaFileName: `${"x".repeat(300)}.mp4` }, "too long");
    console.log("rejections: ok");
  }

  // Load the file in Blender when it's installed (optional — skip otherwise).
  {
    const probe = spawnSync("blender", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) {
      console.warn("SKIP: blender not installed; .blend load check skipped");
    } else {
      const dir = mkdtempSync(join(tmpdir(), "rescript-blend-"));
      try {
        const path = join(dir, "edit.blend");
        writeFileSync(path, Buffer.from(await (await writeBlendProject(base)).arrayBuffer()));
        const py = spawnSync(
          "blender",
          [
            "-b",
            "--factory-startup",
            path,
            "--python-expr",
            `
import bpy, sys
sc = bpy.context.scene
ss = sorted(sc.sequence_editor.strips_all, key=lambda s: (s.frame_final_start, s.channel))
got = [(s.type, s.frame_final_start, s.frame_final_end) for s in ss]
want = [("SOUND", 1, 103), ("MOVIE", 1, 104), ("SOUND", 104, 275), ("MOVIE", 104, 276),
        ("SOUND", 276, 540), ("MOVIE", 276, 541), ("SOUND", 541, 1270), ("MOVIE", 541, 1270),
        ("MOVIE", 1270, 1271)]
ok = (got == want and sc.render.fps == 30 and sc.frame_end == 1270
      and all(s.filepath == "//interview.mp4" for s in ss if s.type == "MOVIE")
      and [w.workspace.name for w in bpy.data.window_managers[0].windows] == ["Video Editing"])
print("BLENDER_CHECK", "ok" if ok else got)
sys.exit(0 if ok else 1)
`,
          ],
          { encoding: "utf8", timeout: 120_000 }
        );
        const line = py.stdout.split("\n").find((l) => l.startsWith("BLENDER_CHECK"));
        if (py.status !== 0 || !line?.endsWith("ok")) {
          console.error(py.stdout.slice(-2000), py.stderr.slice(-2000));
          throw new Error("Blender load check failed");
        }
        console.log("blender load: ok");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  console.log("ALL BLEND TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
