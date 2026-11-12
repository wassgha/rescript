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
  defaultExportResolution,
  ExportInputLimitError,
  exportInputCount,
  MAX_EXPORT_INPUTS,
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
    eq(plan.inputs, [[]], "a monotonic edit reads one plain input");
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

  // VideoToolbox swaps only the video encoder; filtergraph, maps, audio and
  // muxer flags stay identical, so a software retry renders the same edit.
  {
    const x264 = buildVideoExport(ranges, { resolution: "1080" });
    const vt = buildVideoExport(ranges, { resolution: "1080" }, { h264Encoder: "h264_videotoolbox" });
    eq(vt.filter, x264.filter, "VideoToolbox keeps the filtergraph");
    eq(vt.streamArgs, x264.streamArgs, "VideoToolbox keeps the maps");
    eq(
      vt.codecArgs,
      [
        "-c:v", "h264_videotoolbox", "-q:v", "65",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
      ],
      "VideoToolbox codec args"
    );
    // WebM has no hardware VP9 encoder; the option is ignored there.
    const webm = buildVideoExport(ranges, { format: "webm" }, { h264Encoder: "h264_videotoolbox" });
    assert(webm.codecArgs.includes("libvpx-vp9"), "WebM stays on libvpx");
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
        "[outv]scale=w='trunc(iw*min(1,1080/min(iw,ih))/2)*2':h='trunc(ih*min(1,1080/min(iw,ih))/2)*2'[vout]",
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
  assert(scaleFilter("2160")?.includes("2160/min(iw,ih)"), "4K caps the short side at 2160");
  assert(scaleFilter("720")?.includes("720/min(iw,ih)"), "720p caps the short side at 720");

  // Default export size: 1080p for anything bigger, the source otherwise.
  eq(defaultExportResolution(3840, 2160), "1080", "4K landscape defaults to 1080p");
  eq(defaultExportResolution(2160, 3840), "1080", "4K portrait defaults to 1080p");
  eq(defaultExportResolution(2560, 1440), "1080", "1440p defaults to 1080p");
  eq(defaultExportResolution(1920, 1080), "original", "1080p stays original");
  eq(defaultExportResolution(1080, 1920), "original", "vertical 1080p stays original");
  eq(defaultExportResolution(1280, 720), "original", "720p stays original");
  eq(defaultExportResolution(0, 0), "1080", "unknown size defaults to 1080p (never upscales)");

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

  // A monotonic edit is one run however late it starts, and ranges that touch
  // stay in it: one plain input, trims in absolute source seconds.
  {
    const late = buildVideoExport([{ start: 12.457, end: 15.2 }, { start: 15.2, end: 20 }], {});
    eq(late.inputs, [[]], "late monotonic edit has no seek");
    eq(
      late.filter,
      "[0:v]trim=start=12.457:end=15.200,setpts=PTS-STARTPTS[v0];" +
        "[0:a]atrim=start=12.457:end=15.200,asetpts=PTS-STARTPTS[a0];" +
        "[0:v]trim=start=15.200:end=20.000,setpts=PTS-STARTPTS[v1];" +
        "[0:a]atrim=start=15.200:end=20.000,asetpts=PTS-STARTPTS[a1];" +
        "[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]",
      "late monotonic filtergraph"
    );
    eq(buildAudioExport([{ start: 12.457, end: 15.2 }]).inputs, [[]], "audio: one plain input");
  }

  // A reordered edit: every monotonic run gets its own input, seeked to a
  // whole second two before the run starts, and its trims move with it. The
  // repeat of the same range is a run of its own.
  {
    const reordered = [
      { start: 12.457, end: 15.2 },
      { start: 3.333, end: 5 },
      { start: 3.333, end: 5 },
    ];
    const plan = buildVideoExport(reordered, {});
    eq(
      plan.inputs,
      [
        ["-ss", "10", "-t", "6.200"],
        ["-ss", "1", "-t", "5.000"],
        ["-ss", "1", "-t", "5.000"],
      ],
      "reordered edit: one seeked input per run, a repeat included"
    );
    eq(
      plan.filter,
      "[0:v]trim=start=2.457:end=5.200,setpts=PTS-STARTPTS[v0];" +
        "[0:a]atrim=start=2.457:end=5.200,asetpts=PTS-STARTPTS[a0];" +
        "[1:v]trim=start=2.333:end=4.000,setpts=PTS-STARTPTS[v1];" +
        "[1:a]atrim=start=2.333:end=4.000,asetpts=PTS-STARTPTS[a1];" +
        "[2:v]trim=start=2.333:end=4.000,setpts=PTS-STARTPTS[v2];" +
        "[2:a]atrim=start=2.333:end=4.000,asetpts=PTS-STARTPTS[a2];" +
        "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[outv][outa]",
      "reordered filtergraph reads each run's own input, relative to its seek"
    );
    eq(plan.streamArgs, ["-map", "[outv]", "-map", "[outa]"], "reordered maps are unchanged");
    eq(
      buildAudioExport(reordered, { format: "wav" }).inputs,
      plan.inputs,
      "audio export splits into the same runs"
    );
    eq(
      buildAudioExport(reordered, { format: "wav" }).filter,
      "[0:a]atrim=start=2.457:end=5.200,asetpts=PTS-STARTPTS[a0];" +
        "[1:a]atrim=start=2.333:end=4.000,asetpts=PTS-STARTPTS[a1];" +
        "[2:a]atrim=start=2.333:end=4.000,asetpts=PTS-STARTPTS[a2];" +
        "[a0][a1][a2]concat=n=3:v=0:a=1[outa]",
      "reordered audio filtergraph"
    );
  }

  // Several ranges can share a run; a run near the start of the file has no
  // seek (its offset would be negative) but is still cut off at its last range.
  {
    const plan = buildVideoExport(
      [
        { start: 20, end: 22 },
        { start: 23, end: 25 },
        { start: 1, end: 2 },
        { start: 3, end: 4 },
      ],
      { withAudio: false }
    );
    eq(plan.inputs, [["-ss", "18", "-t", "8.000"], ["-t", "5.000"]], "runs of several ranges");
    eq(
      plan.filter,
      "[0:v]trim=start=2.000:end=4.000,setpts=PTS-STARTPTS[v0];" +
        "[0:v]trim=start=5.000:end=7.000,setpts=PTS-STARTPTS[v1];" +
        "[1:v]trim=start=1.000:end=2.000,setpts=PTS-STARTPTS[v2];" +
        "[1:v]trim=start=3.000:end=4.000,setpts=PTS-STARTPTS[v3];" +
        "[v0][v1][v2][v3]concat=n=4:v=1:a=0[outv]",
      "silent reordered filtergraph"
    );
    eq(exportInputCount([{ start: 20, end: 22 }, { start: 1, end: 2 }]), 2, "input count");
  }

  // The input cap: the 48th run still renders, the 49th throws.
  {
    const descending = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ start: 1000 - i * 10, end: 1001 - i * 10 }));
    eq(MAX_EXPORT_INPUTS, 48, "input cap");
    eq(buildVideoExport(descending(48), {}).inputs.length, 48, "48 inputs are allowed");
    eq(buildAudioExport(descending(48)).inputs.length, 48, "48 audio inputs are allowed");
    for (const build of [
      () => buildVideoExport(descending(49), {}),
      () => buildAudioExport(descending(49)),
    ]) {
      let thrown: unknown;
      try {
        build();
      } catch (err) {
        thrown = err;
      }
      assert(thrown instanceof ExportInputLimitError, "49 inputs throw ExportInputLimitError");
      eq([thrown.inputs, thrown.max], [49, 48], "the error reports the needed and allowed inputs");
    }
    // Many ranges in few runs are fine.
    const ascending = Array.from({ length: 500 }, (_, i) => ({ start: i, end: i + 0.5 }));
    eq(exportInputCount(ascending), 1, "a long monotonic edit is one input");
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
      { ...video, keepRanges: [{ start: 0, end: 1 }, { start: 3, end: 3 }] },
      { ...video, keepRanges: [{ start: 0, end: 1 }, { start: -1, end: 0.5 }] },
      { ...video, keepRanges: [{ start: Number.NaN, end: 1 }] },
      { ...video, keepRanges: [{ start: "0;[0:v]", end: 1 }] },
      { ...video, keepRanges: [{ start: 0, end: Number.POSITIVE_INFINITY }] },
      { ...video, keepRanges: [null] },
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

    // Reordered, repeated and overlapping ranges are an edit, not malformed
    // input; the same range after itself is two inputs, not an error.
    for (const keepRanges of [
      [{ start: 4, end: 5 }, { start: 0, end: 1 }],
      [{ start: 2, end: 3 }, { start: 2, end: 3 }],
      [{ start: 0, end: 2 }, { start: 1, end: 3 }],
    ]) {
      const reordered = { ...video, keepRanges };
      eq(parseExportRequest(reordered), reordered, "reordered request round-trips");
    }

    // The input cap is part of validation: more runs than MAX_EXPORT_INPUTS.
    const runs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ start: 1000 - i * 10, end: 1001 - i * 10 }));
    assert(parseExportRequest({ ...video, keepRanges: runs(48) }), "48 runs are accepted");
    eq(parseExportRequest({ ...video, keepRanges: runs(49) }), null, "49 runs are rejected");

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
