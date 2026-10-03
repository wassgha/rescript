/**
 * The desktop app's native media engine, end to end against the same static
 * ffmpeg it bundles (scripts/fetch-ffmpeg.mjs --host): every export preset
 * through the exact argv electron/media.ts runs, audio extraction, progress,
 * cancellation, and the "binary can't run here" classification that sends the
 * renderer back to ffmpeg.wasm.
 *
 * Skips the rendering half when the binary hasn't been fetched, so a plain
 * `npm test` without network still passes; CI fetches it first.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildAudioExport,
  buildVideoExport,
  extractAudioArgs,
  VIDEOTOOLBOX_QUALITY,
  type ExportPlan,
} from "../lib/exportArgs";
import {
  nativeExportArgs,
  parseVideoStream,
  probeFFmpeg,
  probeHardwareEncoder,
  probeVideoStream,
  REQUIRED_ENCODERS,
  REQUIRED_FILTERS,
  resolveBinary,
  runAttempts,
  runFFmpeg,
  wantsHardwareDecode,
} from "../electron/ffmpegRunner";
import * as fetchScript from "../scripts/fetch-ffmpeg.mjs";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const root = join(import.meta.dirname, "..");

/** Duration of a media file, as ffmpeg itself reads it back. */
function probeDuration(bin: string, file: string): number {
  const out = spawnSync(bin, ["-hide_banner", "-i", file, "-f", "null", "-"], {
    encoding: "utf8",
  });
  const matches = [...out.stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
  const last = matches.at(-1);
  assert(last, `could not read back ${file}:\n${out.stderr.slice(-2000)}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

function staticChecks() {
  // The build script and the runtime probe must agree on what a usable build has.
  const script = fetchScript as {
    REQUIRED_ENCODERS: string[];
    REQUIRED_FILTERS: string[];
    TARGETS: Record<string, string>;
    ASSETS: Record<string, unknown>;
  };
  assert(
    JSON.stringify(script.REQUIRED_ENCODERS) === JSON.stringify(REQUIRED_ENCODERS),
    "fetch-ffmpeg and ffmpegRunner require the same encoders"
  );
  assert(
    JSON.stringify(script.REQUIRED_FILTERS) === JSON.stringify(REQUIRED_FILTERS),
    "fetch-ffmpeg and ffmpegRunner require the same filters"
  );

  // Every os/arch electron-builder targets needs a binary, or that installer
  // would ship without one (after-pack.cjs fails the build; this fails sooner).
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const wanted: string[] = [];
  for (const os of ["mac", "win", "linux"]) {
    for (const target of pkg.build[os].target) {
      const arches: string[] = typeof target === "string" ? ["x64"] : target.arch ?? ["x64"];
      for (const arch of arches) wanted.push(`${os}-${arch}`);
    }
  }
  for (const target of new Set(wanted)) {
    const asset = script.TARGETS[target];
    assert(asset, `no ffmpeg target for ${target}`);
    assert(script.ASSETS[asset], `no pinned digests for ${asset}`);
  }

  // Binary resolution.
  const base = { resourcesPath: "/res", repoRoot: "/repo", env: {} };
  assert(
    resolveBinary({ ...base, packaged: true, platform: "darwin", arch: "arm64" }) ===
      join("/res", "ffmpeg", "ffmpeg"),
    "packaged builds use resources/ffmpeg"
  );
  assert(
    resolveBinary({ ...base, packaged: true, platform: "win32", arch: "x64" }) ===
      join("/res", "ffmpeg", "ffmpeg.exe"),
    "Windows binary has .exe"
  );
  assert(
    resolveBinary({ ...base, packaged: false, platform: "darwin", arch: "x64" }) ===
      join("/repo", "build", "ffmpeg", "mac-x64", "ffmpeg"),
    "dev builds use build/ffmpeg/<os>-<arch>"
  );
  assert(
    resolveBinary({ ...base, packaged: true, env: { RESCRIPT_MEDIA_ENGINE: "wasm" } }) === null,
    "RESCRIPT_MEDIA_ENGINE=wasm disables native"
  );
  assert(
    resolveBinary({ ...base, packaged: true, env: { RESCRIPT_FFMPEG_PATH: "/x/ffmpeg" } }) ===
      "/x/ffmpeg",
    "RESCRIPT_FFMPEG_PATH overrides"
  );

  // Input dumps as the bundled builds print them.
  const streams: Array<[string, ReturnType<typeof parseVideoStream>]> = [
    [
      "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 16050 kb/s, 30 fps",
      { codec: "h264", pixFmt: "yuv420p", width: 1920, height: 1080 },
    ],
    [
      // iPhone HDR: commas and slashes inside the colour info.
      "  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 3840x2160, 46000 kb/s, 29.97 fps",
      { codec: "hevc", pixFmt: "yuv420p10le", width: 3840, height: 2160 },
    ],
    [
      "  Stream #0:0: Video: prores (HQ) (apch / 0x68637061), yuv422p10le(tv, bt709, progressive), 1920x1080, 176000 kb/s",
      { codec: "prores", pixFmt: "yuv422p10le", width: 1920, height: 1080 },
    ],
    [
      "  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv, bt709), 1280x720, SAR 1:1 DAR 16:9, 30 fps",
      { codec: "vp9", pixFmt: "yuv420p", width: 1280, height: 720 },
    ],
    [
      // Cover art on an audio file is not a video to decode.
      "  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)",
      null,
    ],
    ["  Stream #0:0: Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp", null],
  ];
  for (const [line, expected] of streams) {
    const got = parseVideoStream(`Input #0, mov,mp4, from 'x.mp4':\n${line}`);
    assert(
      JSON.stringify(got) === JSON.stringify(expected),
      `parseVideoStream(${line.trim().slice(0, 40)}…) = ${JSON.stringify(got)}`
    );
  }

  // Hardware decode only where it was measured to win: HEVC / ProRes / AV1 on a Mac.
  const info = (codec: string) => ({ codec, pixFmt: "yuv420p", width: 3840, height: 2160 });
  assert(wantsHardwareDecode(info("hevc"), "darwin"), "HEVC decodes on the GPU");
  assert(wantsHardwareDecode(info("prores"), "darwin"), "ProRes decodes on the GPU");
  assert(!wantsHardwareDecode(info("h264"), "darwin"), "H.264 stays in software (faster)");
  assert(!wantsHardwareDecode(info("hevc"), "win32"), "no hardware decode off macOS");
  assert(!wantsHardwareDecode(null, "darwin"), "no video stream, no hardware decode");
  assert(
    nativeExportArgs("in.mov", "g.txt", buildVideoExport([{ start: 0, end: 1 }]), "o.mp4", {
      hardwareDecode: true,
    }).slice(0, 4).join(" ") === "-hwaccel videotoolbox -i in.mov",
    "hardware decode is an input option"
  );
}

async function render(
  bin: string,
  dir: string,
  input: string,
  plan: ExportPlan,
  name: string
): Promise<{ out: string; progress: number[] }> {
  const graph = join(dir, `${name}.txt`);
  writeFileSync(graph, plan.filter);
  const out = join(dir, `${name}.${plan.ext}`);
  const progress: number[] = [];
  const outcome = await runFFmpeg(bin, nativeExportArgs(input, graph, plan, out), {
    onProgress: (s) => progress.push(s),
  });
  assert(outcome.ok, `${name} failed: ${outcome.ok ? "" : outcome.detail}\n${outcome.stderrTail.slice(-2000)}`);
  assert(statSync(out).size > 0, `${name} wrote output`);
  return { out, progress };
}

async function main() {
  staticChecks();

  // A missing binary is "unavailable" (fall back), never a job failure.
  {
    const missing = await runFFmpeg(join(tmpdir(), "no-such-ffmpeg"), ["-version"]);
    assert(!missing.ok && missing.code === "unavailable", "missing binary is unavailable");
    const probe = await probeFFmpeg(join(tmpdir(), "no-such-ffmpeg"));
    assert(!probe.ok, "probe fails for a missing binary");
  }

  const bin = resolveBinary({
    packaged: false,
    resourcesPath: "",
    repoRoot: root,
    env: {},
  });
  if (!bin || !existsSync(bin)) {
    console.log(
      "SKIPPED native render tests (run `npm run fetch:ffmpeg -- --host` to enable)"
    );
    console.log("ALL NATIVE FFMPEG TESTS PASSED");
    return;
  }

  const probe = await probeFFmpeg(bin);
  assert(probe.ok, `bundled ffmpeg passes the probe: ${probe.ok ? "" : probe.detail}`);

  const dir = mkdtempSync(join(tmpdir(), "rescript-native-test-"));
  try {
    // 6s source: 320x240 test pattern + 440 Hz tone, with spaces in the path
    // (the user's media lives wherever they keep it).
    const input = join(dir, "source clip.mp4");
    const made = spawnSync(bin, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", "-y", input,
    ]);
    assert(made.status === 0, `fixture: ${made.stderr}`);
    const silent = join(dir, "silent.mp4");
    spawnSync(bin, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-y", silent,
    ]);

    const ranges = [
      { start: 0, end: 1 },
      { start: 2, end: 3.5 },
      { start: 4.25, end: 6 },
    ];
    const kept = 1 + 1.5 + 1.75;

    const cases: Array<[string, ExportPlan]> = [
      ["mp4-original", buildVideoExport(ranges, {}, { x264Preset: "veryfast" })],
      ["mp4-720", buildVideoExport(ranges, { resolution: "720" }, { x264Preset: "veryfast" })],
      ["webm", buildVideoExport(ranges, { format: "webm" })],
      ["m4a", buildAudioExport(ranges, { format: "m4a" })],
      ["mp3", buildAudioExport(ranges, { format: "mp3" })],
      ["wav", buildAudioExport(ranges, { format: "wav" })],
    ];
    for (const [name, plan] of cases) {
      const { out, progress } = await render(bin, dir, input, plan, name);
      const duration = probeDuration(bin, out);
      assert(
        Math.abs(duration - kept) < 0.15,
        `${name}: expected ~${kept}s, got ${duration}s`
      );
      assert(progress.length > 0, `${name}: reported progress`);
      assert(progress.every((s) => s >= 0), `${name}: progress is never negative`);
    }

    // A silent source renders without its (missing) audio track.
    {
      const plan = buildVideoExport([{ start: 0.5, end: 2.5 }], { withAudio: false });
      const { out } = await render(bin, dir, silent, plan, "silent-out");
      assert(Math.abs(probeDuration(bin, out) - 2) < 0.15, "silent export duration");
    }

    // Many cuts: a graph far past what would fit on a Windows command line.
    {
      const many = Array.from({ length: 300 }, (_, i) => ({
        start: i * 0.02,
        end: i * 0.02 + 0.012,
      }));
      const plan = buildVideoExport(many, {}, { x264Preset: "veryfast" });
      assert(plan.filter.length > 32_768, "graph is past Windows' command-line limit");
      await render(bin, dir, input, plan, "many-cuts");
    }

    // Extraction: 16 kHz mono f32 — 6s is 96000 samples.
    {
      const pcm = join(dir, "audio.f32");
      const outcome = await runFFmpeg(bin, extractAudioArgs(input, pcm));
      assert(outcome.ok, "extraction succeeds");
      const samples = statSync(pcm).size / 4;
      assert(Math.abs(samples - 96_000) < 1_600, `extracted ~96000 samples, got ${samples}`);
    }

    // No audio track: a job failure (no-audio upstream), not "unavailable".
    {
      const outcome = await runFFmpeg(bin, extractAudioArgs(silent, join(dir, "none.f32")));
      assert(!outcome.ok && outcome.code === "failed", "silent extraction fails as a job");
    }

    // A corrupt input is a job failure too — falling back wouldn't help.
    {
      const junk = join(dir, "junk.mp4");
      writeFileSync(junk, "not a video");
      const outcome = await runFFmpeg(bin, extractAudioArgs(junk, join(dir, "junk.f32")));
      assert(!outcome.ok && outcome.code === "failed", "corrupt input is failed");
      assert(outcome.stderrTail.length > 0, "stderr is kept for the report");
    }

    // Fallback: a failing first attempt hands over to the next, which
    // renders the same plan into the same output path.
    {
      const plan = buildAudioExport(ranges, { format: "wav" });
      const graph = join(dir, "fallback.txt");
      writeFileSync(graph, plan.filter);
      const out = join(dir, "fallback.wav");
      const good = nativeExportArgs(input, graph, plan, out);
      const broken = good.map((arg) => (arg === "pcm_s16le" ? "no_such_encoder" : arg));
      let retries = 0;
      const result = await runAttempts(
        bin,
        [
          { label: "broken", args: broken },
          { label: "software", args: good },
        ],
        { beforeRetry: () => void retries++ }
      );
      assert(result.outcome.ok && result.used === 1, "falls back to the working attempt");
      assert(retries === 1, "beforeRetry runs between attempts");
      assert(
        result.fallbacks.length === 1 && result.fallbacks[0].startsWith("broken:"),
        "the abandoned attempt is reported"
      );
      assert(Math.abs(probeDuration(bin, out) - kept) < 0.15, "fallback output is the full edit");

      // ...but a cancelled run is not retried.
      const controller = new AbortController();
      controller.abort();
      const cancelled = await runAttempts(
        bin,
        [
          { label: "first", args: good },
          { label: "second", args: good },
        ],
        { signal: controller.signal }
      );
      assert(
        !cancelled.outcome.ok && cancelled.outcome.code === "cancelled" && cancelled.used === 0,
        "cancellation ends the attempts"
      );
    }

    // Short-side scaling: a vertical 1080×1920 video at 720p is 720×1280,
    // not 404×720 (what a height cap would make of it).
    {
      const tall = join(dir, "tall.mp4");
      spawnSync(bin, [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=25:duration=1",
        "-f", "lavfi", "-i", "sine=duration=1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", "-y", tall,
      ]);
      const plan = buildVideoExport([{ start: 0, end: 1 }], { resolution: "720" }, { x264Preset: "veryfast" });
      const { out } = await render(bin, dir, tall, plan, "tall-720");
      const stream = await probeVideoStream(bin, out);
      assert(
        stream?.width === 720 && stream.height === 1280,
        `vertical 720p export is 720x1280, got ${stream?.width}x${stream?.height}`
      );
    }

    // macOS: VideoToolbox decode + encode on an HEVC 10-bit source, the iPhone
    // case it exists for. Intel Macs without constant-quality VideoToolbox
    // skip it (they use libx264).
    if (process.platform === "darwin" && (await probeHardwareEncoder(bin, VIDEOTOOLBOX_QUALITY))) {
      const hevc = join(dir, "iphone.mov");
      const made = spawnSync(bin, [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=6,format=p010le",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-c:v", "hevc_videotoolbox", "-profile:v", "main10", "-tag:v", "hvc1", "-b:v", "4M",
        "-c:a", "aac", "-shortest", "-y", hevc,
      ]);
      assert(made.status === 0, `HEVC fixture: ${made.stderr}`);
      const source = await probeVideoStream(bin, hevc);
      assert(source?.codec === "hevc" && wantsHardwareDecode(source), "HEVC source is detected");

      const plan = buildVideoExport(ranges, { resolution: "720" }, { h264Encoder: "h264_videotoolbox" });
      const graph = join(dir, "vt.txt");
      writeFileSync(graph, plan.filter);
      const out = join(dir, "vt.mp4");
      const progress: number[] = [];
      const outcome = await runFFmpeg(
        bin,
        nativeExportArgs(hevc, graph, plan, out, { hardwareDecode: true }),
        { onProgress: (s) => progress.push(s) }
      );
      assert(outcome.ok, `VideoToolbox export: ${outcome.ok ? "" : outcome.stderrTail.slice(-1500)}`);
      const result = await probeVideoStream(bin, out);
      assert(
        result?.codec === "h264" && result.pixFmt === "yuv420p",
        `VideoToolbox export is 8-bit H.264, got ${JSON.stringify(result)}`
      );
      assert(Math.abs(probeDuration(bin, out) - kept) < 0.15, "VideoToolbox export duration");
      assert(progress.length > 0, "VideoToolbox export reports progress");
    } else {
      console.log("SKIPPED VideoToolbox render (not an Apple Silicon Mac)");
    }

    // Cancellation kills the encode promptly.
    {
      const controller = new AbortController();
      const plan = buildVideoExport([{ start: 0, end: 3600 }], {
        format: "webm",
        withAudio: false,
      });
      const graph = join(dir, "cancel.txt");
      writeFileSync(graph, plan.filter);
      const looped = [
        "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=3600",
      ];
      const started = Date.now();
      const pending = runFFmpeg(
        bin,
        [...looped, ...nativeExportArgs(input, graph, plan, join(dir, "cancel.webm")).slice(2)],
        { signal: controller.signal }
      );
      setTimeout(() => controller.abort(), 300);
      const outcome = await pending;
      assert(!outcome.ok && outcome.code === "cancelled", "aborted run reports cancelled");
      assert(Date.now() - started < 5000, "cancellation is prompt");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("ALL NATIVE FFMPEG TESTS PASSED");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
