#!/usr/bin/env node
/**
 * Download the native ffmpeg the desktop app renders exports with.
 *
 * The browser build runs ffmpeg.wasm, which tops out at a 2 GiB heap and holds
 * the whole encoded output in memory — the reason long or high-resolution
 * desktop exports died with "memory access out of bounds". The desktop app
 * instead ships a static ffmpeg per platform/arch and drives it from the main
 * process (electron/media.ts), reading the source from disk and writing the
 * render straight back to it.
 *
 * Binaries are the pinned eugeneware/ffmpeg-static release (GPL builds with
 * x264, libvpx, opus and lame), verified against the SHA-256 digests below and
 * written to build/ffmpeg/<os>-<arch>/, where <os>-<arch> matches
 * electron-builder's `${os}-${arch}` macro so `extraResources` picks the right
 * one per target. The release's LICENSE / README are shipped beside the binary.
 *
 *   node scripts/fetch-ffmpeg.mjs           # every target this OS builds
 *   node scripts/fetch-ffmpeg.mjs --host    # just this machine (dev, CI tests)
 *
 * Re-running is cheap: a binary whose hash already matches is left alone.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const RELEASE_TAG = "b6.1.1";
const RELEASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE_TAG}`;

/** SHA-256 of each upstream asset (uncompressed), from the GitHub release API. */
export const ASSETS = {
  "darwin-arm64": {
    binary: "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584",
    license: "cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2",
    readme: "05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a",
  },
  "darwin-x64": {
    binary: "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894",
    license: "2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af",
    readme: "e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36",
  },
  "linux-x64": {
    binary: "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99",
    license: "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
    readme: "72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537",
  },
  "win32-x64": {
    binary: "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
    license: "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
    readme: "a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311",
  },
};

/**
 * electron-builder `${os}-${arch}` → upstream asset. Windows on Arm has no
 * upstream build; the x64 binary runs there under the OS's x64 emulation.
 */
export const TARGETS = {
  "mac-arm64": "darwin-arm64",
  "mac-x64": "darwin-x64",
  "win-x64": "win32-x64",
  "win-arm64": "win32-x64",
  "linux-x64": "linux-x64",
};

/** Encoders / filters the export presets in lib/exportArgs.ts rely on. */
export const REQUIRED_ENCODERS = [
  "libx264",
  "libvpx-vp9",
  "libopus",
  "aac",
  "libmp3lame",
  "pcm_s16le",
];
export const REQUIRED_FILTERS = ["trim", "atrim", "concat", "scale"];

const OS_NAME = { darwin: "mac", win32: "win", linux: "linux" };

export function hostTarget() {
  const os = OS_NAME[process.platform];
  return os ? `${os}-${process.arch}` : null;
}

function targetsForHost() {
  const os = OS_NAME[process.platform];
  return Object.keys(TARGETS).filter((t) => t.startsWith(`${os}-`));
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchVerified(url, expected, { gzip = false } = {}) {
  let buf = await download(url);
  if (gzip) buf = gunzipSync(buf);
  const actual = sha256(buf);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`);
  }
  return buf;
}

function writeAtomic(path, buf, mode) {
  const tmp = `${path}.partial`;
  writeFileSync(tmp, buf, mode ? { mode } : undefined);
  renameSync(tmp, path);
  if (mode) chmodSync(path, mode);
}

/**
 * Exercise a binary this machine can run: it must start, and it must carry
 * every encoder/filter the presets use. Returns false when the host can't
 * execute it at all (e.g. the x64 build on an arm64 Mac without Rosetta).
 */
function verifyRunnable(bin) {
  const version = spawnSync(bin, ["-hide_banner", "-version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) return false;
  const encoders = spawnSync(bin, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  const filters = spawnSync(bin, ["-hide_banner", "-filters"], { encoding: "utf8" });
  for (const name of REQUIRED_ENCODERS) {
    if (!new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(encoders.stdout)) {
      throw new Error(`${bin} is missing the ${name} encoder`);
    }
  }
  for (const name of REQUIRED_FILTERS) {
    if (!new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(filters.stdout)) {
      throw new Error(`${bin} is missing the ${name} filter`);
    }
  }
  console.log(`[fetch-ffmpeg]   ${version.stdout.split("\n")[0]}`);
  return true;
}

/** A static macOS build must only link the OS — anything else won't be on users' Macs. */
function verifyMacLinkage(bin) {
  if (process.platform !== "darwin") return;
  const out = spawnSync("otool", ["-L", bin], { encoding: "utf8" });
  if (out.error || out.status !== 0) return;
  const libs = out.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);
  const foreign = libs.filter((lib) => !lib.startsWith("/usr/lib/") && !lib.startsWith("/System/"));
  if (foreign.length > 0) {
    throw new Error(`${bin} links non-system libraries: ${foreign.join(", ")}`);
  }
}

async function fetchTarget(target) {
  const asset = TARGETS[target];
  const digests = ASSETS[asset];
  const dir = join(root, "build", "ffmpeg", target);
  const bin = join(dir, asset.startsWith("win32") ? "ffmpeg.exe" : "ffmpeg");
  mkdirSync(dir, { recursive: true });

  if (existsSync(bin) && sha256(readFileSync(bin)) === digests.binary) {
    console.log(`[fetch-ffmpeg] ${target}: up to date`);
  } else {
    console.log(`[fetch-ffmpeg] ${target}: downloading ffmpeg-${asset} (${RELEASE_TAG})`);
    const buf = await fetchVerified(`${RELEASE_URL}/ffmpeg-${asset}.gz`, digests.binary, {
      gzip: true,
    });
    writeAtomic(bin, buf, 0o755);
  }

  for (const [kind, file] of [
    ["license", "LICENSE.txt"],
    ["readme", "README.txt"],
  ]) {
    const dst = join(dir, file);
    if (existsSync(dst) && sha256(readFileSync(dst)) === digests[kind]) continue;
    const buf = await fetchVerified(`${RELEASE_URL}/${asset}.${kind.toUpperCase()}`, digests[kind]);
    writeAtomic(dst, buf);
  }

  verifyMacLinkage(bin);
  if (!verifyRunnable(bin)) {
    console.log(`[fetch-ffmpeg]   (not runnable on this machine; skipped encoder check)`);
  }
}

async function main() {
  const hostOnly = process.argv.includes("--host");
  const targets = hostOnly ? [hostTarget()].filter((t) => t && TARGETS[t]) : targetsForHost();
  if (targets.length === 0) {
    const message = `[fetch-ffmpeg] no native ffmpeg for ${process.platform}-${process.arch}`;
    // Dev on an unsupported machine still works — the app falls back to wasm.
    if (hostOnly) {
      console.warn(`${message}; the app will use ffmpeg.wasm.`);
      return;
    }
    throw new Error(message);
  }
  for (const target of targets) await fetchTarget(target);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
