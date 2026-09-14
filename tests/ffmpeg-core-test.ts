/**
 * Regression: video export must use the growable single-threaded ffmpeg core.
 *
 * `@ffmpeg/core-mt` hard-declares a fixed 1 GiB shared WebAssembly.Memory.
 * High-res exports (1080p / original) and Electron sessions that still hold
 * ASR heaps either fail to instantiate that buffer ("ffmpeg not starting") or
 * OOM mid-encode. `@ffmpeg/core` grows 32 MiB → 2 GiB and is what export
 * selects; copy-assets must ship both binaries.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  coreAssetBase,
  exportCoreKind,
  type FFmpegCoreKind,
} from "../lib/ffmpeg";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function main() {
  assert(exportCoreKind() === "st", "export uses the single-threaded core");
  assert(
    coreAssetBase("st") === "/vendor/ffmpeg-st",
    "ST assets are served from /vendor/ffmpeg-st"
  );
  assert(
    coreAssetBase("mt") === "/vendor/ffmpeg",
    "MT assets stay at /vendor/ffmpeg"
  );

  const root = join(import.meta.dirname, "..");
  const required: Record<FFmpegCoreKind, string[]> = {
    mt: ["ffmpeg-core.js", "ffmpeg-core.wasm", "ffmpeg-core.worker.js"],
    st: ["ffmpeg-core.js", "ffmpeg-core.wasm"],
  };
  for (const kind of Object.keys(required) as FFmpegCoreKind[]) {
    const dir = join(root, "public", ...coreAssetBase(kind).split("/").filter(Boolean));
    for (const file of required[kind]) {
      assert(
        existsSync(join(dir, file)),
        `missing ${kind} asset ${file} under ${dir} (run postinstall / copy-assets)`
      );
    }
    if (kind === "st") {
      assert(
        !existsSync(join(dir, "ffmpeg-core.worker.js")),
        "single-threaded core must not ship a pthread worker"
      );
    }
  }

  console.log("ALL FFMPEG CORE TESTS PASSED");
}

main();
