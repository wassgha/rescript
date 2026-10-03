/**
 * The export argv is shared by ffmpeg.wasm and the desktop app's native
 * ffmpeg (lib/exportArgs.ts). Pin it against the commands export has always
 * run, so moving it out of lib/ffmpeg.ts can't change what either engine
 * renders — plus the request validation the main process relies on, and the
 * `-progress` parser.
 */
import {
  buildAudioExport,
  buildVideoExport,
  createProgressParser,
  parseExportRequest,
  progressRatio,
  scaleFilter,
} from "../lib/exportArgs";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected ${e}\n  actual   ${a}`);
}

const ranges = [
  { start: 0, end: 1.5 },
  { start: 2.25, end: 4 },
];

function main() {
  // Video, with audio, original resolution — the default export.
  {
    const plan = buildVideoExport(ranges, {});
    eq(
      plan.filter,
      "[0:v]trim=start=0.000:end=1.500,setpts=PTS-STARTPTS[v0];" +
        "[0:a]atrim=start=0.000:end=1.500,asetpts=PTS-STARTPTS[a0];" +
        "[0:v]trim=start=2.250:end=4.000,setpts=PTS-STARTPTS[v1];" +
        "[0:a]atrim=start=2.250:end=4.000,asetpts=PTS-STARTPTS[a1];" +
        "[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]",
      "video filtergraph"
    );
    eq(plan.streamArgs, ["-map", "[outv]", "-map", "[outa]"], "video maps");
    eq(
      plan.codecArgs,
      [
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
      ],
      "mp4 codec args (wasm keeps ultrafast)"
    );
    eq([plan.ext, plan.mime], ["mp4", "video/mp4"], "mp4 container");
  }

  // Native tuning only changes the preset.
  {
    const plan = buildVideoExport(ranges, {}, { x264Preset: "veryfast" });
    assert(plan.codecArgs.join(" ").includes("-preset veryfast"), "native x264 preset");
  }

  // Silent source, scaled, WebM.
  {
    const plan = buildVideoExport(ranges, {
      withAudio: false,
      format: "webm",
      resolution: "1080",
    });
    eq(
      plan.filter,
      "[0:v]trim=start=0.000:end=1.500,setpts=PTS-STARTPTS[v0];" +
        "[0:v]trim=start=2.250:end=4.000,setpts=PTS-STARTPTS[v1];" +
        "[v0][v1]concat=n=2:v=1:a=0[outv];" +
        "[outv]scale=-2:'min(ih,1080)',scale=trunc(iw/2)*2:trunc(ih/2)*2[vout]",
      "silent scaled filtergraph"
    );
    eq(plan.streamArgs, ["-map", "[vout]", "-an"], "silent maps");
    eq(
      plan.codecArgs,
      [
        "-c:v", "libvpx-vp9", "-crf", "35", "-b:v", "0", "-row-mt", "1",
        "-cpu-used", "8", "-pix_fmt", "yuv420p",
      ],
      "webm codec args without audio"
    );
    eq([plan.ext, plan.mime], ["webm", "video/webm"], "webm container");
  }

  eq(scaleFilter("original"), null, "original is not scaled");
  assert(scaleFilter("2160")?.includes("min(ih,2160)"), "4K caps at 2160");

  // Audio presets.
  {
    const m4a = buildAudioExport(ranges, {});
    eq(
      m4a.filter,
      "[0:a]atrim=start=0.000:end=1.500,asetpts=PTS-STARTPTS[a0];" +
        "[0:a]atrim=start=2.250:end=4.000,asetpts=PTS-STARTPTS[a1];" +
        "[a0][a1]concat=n=2:v=0:a=1[outa]",
      "audio filtergraph"
    );
    eq(m4a.streamArgs, ["-map", "[outa]"], "audio maps");
    eq(
      m4a.codecArgs,
      ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      "m4a codec args"
    );
    eq([m4a.ext, m4a.mime], ["m4a", "audio/mp4"], "m4a container");
    const mp3 = buildAudioExport(ranges, { format: "mp3" });
    eq(mp3.codecArgs, ["-c:a", "libmp3lame", "-b:a", "192k"], "mp3 codec args");
    eq(mp3.mime, "audio/mpeg", "mp3 mime");
    const wav = buildAudioExport(ranges, { format: "wav" });
    eq(wav.codecArgs, ["-c:a", "pcm_s16le"], "wav codec args");
    eq(wav.mime, "audio/wav", "wav mime");
  }

  // Request validation: what the main process accepts from the renderer.
  {
    const video = {
      kind: "video",
      keepRanges: ranges,
      editedDuration: 3.25,
      options: { withAudio: true, format: "mp4", resolution: "720" },
    };
    eq(parseExportRequest(video), video, "valid video request round-trips");
    const audio = {
      kind: "audio",
      keepRanges: ranges,
      editedDuration: 3.25,
      options: { format: "wav" },
    };
    eq(parseExportRequest(audio), audio, "valid audio request round-trips");

    const bad: unknown[] = [
      null,
      "video",
      { ...video, kind: "gif" },
      { ...video, keepRanges: [] },
      { ...video, keepRanges: [{ start: 2, end: 1 }] },
      { ...video, keepRanges: [{ start: 0, end: 2 }, { start: 1, end: 3 }] },
      { ...video, keepRanges: [{ start: Number.NaN, end: 1 }] },
      { ...video, keepRanges: [{ start: "0;[0:v]", end: 1 }] },
      { ...video, editedDuration: -1 },
      { ...video, options: { ...video.options, format: "mov" } },
      { ...video, options: { ...video.options, resolution: "480" } },
      { ...video, options: { ...video.options, withAudio: "yes" } },
      { ...audio, options: { format: "flac" } },
      { ...video, keepRanges: Array.from({ length: 20_001 }, (_, i) => ({ start: i, end: i + 0.5 })) },
    ];
    bad.forEach((request, i) => {
      eq(parseExportRequest(request), null, `malformed request #${i} is rejected`);
    });

    // Extra fields are dropped rather than passed through to the builder.
    const extra = parseExportRequest({
      ...video,
      options: { ...video.options, args: ["-f", "null"] },
    });
    eq(extra?.options, video.options, "unknown option keys are dropped");
  }

  // -progress parsing: split across chunks, N/A and negative values ignored.
  {
    const times: number[] = [];
    let ended = 0;
    const feed = createProgressParser(
      (s) => times.push(s),
      () => ended++
    );
    feed("frame=0\nout_time_us=N/A\nout_time_ms=N/A\nprogress=continue\n");
    feed("out_time_us=-23220\nprogress=cont");
    feed("inue\nout_time_us=1500");
    feed("000\nout_time_ms=1500000\nprogress=continue\r\n");
    feed("out_time_us=3250000\nprogress=end\n");
    eq(times, [1.5, 1.5, 3.25], "progress timestamps");
    eq(ended, 1, "progress=end reported once");
  }

  eq(progressRatio(1.5, 3), 0.5, "progress ratio");
  eq(progressRatio(10, 3), 1, "progress ratio clamps high");
  eq(progressRatio(-1, 3), 0, "progress ratio clamps low");
  eq(progressRatio(1, 0), 1, "zero duration does not divide by zero");

  console.log("ALL EXPORT ARGS TESTS PASSED");
}

main();
