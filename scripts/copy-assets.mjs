/**
 * Copies WASM runtime assets from node_modules into public/ so the app can be
 * served fully offline (no CDN requests at runtime):
 *   - @ffmpeg/core-mt  -> public/vendor/ffmpeg/  (audio extraction + export)
 *   - onnxruntime-web  -> public/vendor/ort/     (transformers.js inference)
 *   - parakeet.js ORT  -> public/vendor/ort-parakeet/ (Parakeet TDT inference)
 * Runs automatically on `npm install` (postinstall).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ffmpegSrc = join(root, "node_modules/@ffmpeg/core-mt/dist/esm");
const ffmpegDst = join(root, "public/vendor/ffmpeg");
mkdirSync(ffmpegDst, { recursive: true });
for (const f of readdirSync(ffmpegSrc)) {
  cpSync(join(ffmpegSrc, f), join(ffmpegDst, f));
}

// The @ffmpeg/ffmpeg "class worker" contains a dynamic import() that bundlers
// cannot process; serve the package's own ESM build and point classWorkerURL
// at it instead (see lib/ffmpeg.ts).
const ffmpegClassSrc = join(root, "node_modules/@ffmpeg/ffmpeg/dist/esm");
const ffmpegClassDst = join(root, "public/vendor/ffmpeg-class");
mkdirSync(ffmpegClassDst, { recursive: true });
for (const f of readdirSync(ffmpegClassSrc)) {
  if (f.endsWith(".js") || f.endsWith(".mjs")) {
    cpSync(join(ffmpegClassSrc, f), join(ffmpegClassDst, f));
  }
}

function copyOrtWasm(srcDist, dst) {
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(srcDist)) {
    if (/^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(f)) {
      cpSync(join(srcDist, f), join(dst, f));
    }
  }
}

const ortSrc = join(root, "node_modules/onnxruntime-web/dist");
const ortDst = join(root, "public/vendor/ort");
copyOrtWasm(ortSrc, ortDst);

// Parakeet.js pins onnxruntime-web@1.24.1 (nested). Keep its WASM separate so
// the JS package and binaries stay version-matched.
const parakeetOrtSrc = join(
  root,
  "node_modules/parakeet.js/node_modules/onnxruntime-web/dist"
);
const parakeetOrtDst = join(root, "public/vendor/ort-parakeet");
if (existsSync(parakeetOrtSrc)) {
  copyOrtWasm(parakeetOrtSrc, parakeetOrtDst);
} else {
  // Hoisted install: fall back to the top-level ORT package.
  copyOrtWasm(ortSrc, parakeetOrtDst);
}

/**
 * parakeet.js@1.4.4 accepts `wasmPaths` in fromUrls/fromHub but initOrt never
 * applies the argument — it only sets a jsDelivr CDN default. Patch that so
 * Rescript can serve WASM same-origin (offline after first model download).
 */
function patchParakeetWasmPaths() {
  const backendPath = join(root, "node_modules/parakeet.js/src/backend.js");
  if (!existsSync(backendPath)) return;
  let src = readFileSync(backendPath, "utf8");
  if (src.includes("/* rescript-wasmPaths-patch */")) return;

  // Package may ship CRLF; normalize for matching then restore EOL style.
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const normalized = src.replace(/\r\n/g, "\n");
  const needle =
    "  // Set up WASM paths first (needed for all backends)\n" +
    "  if (!ort.env.wasm.wasmPaths) {";
  const replacement =
    "  // Set up WASM paths first (needed for all backends)\n" +
    "  /* rescript-wasmPaths-patch */\n" +
    "  if (wasmPaths) {\n" +
    "    ort.env.wasm.wasmPaths = wasmPaths;\n" +
    "  } else if (!ort.env.wasm.wasmPaths) {";
  if (!normalized.includes(needle)) {
    console.warn(
      "[copy-assets] Could not patch parakeet.js wasmPaths (needle not found)"
    );
    return;
  }
  let patched = normalized.replace(needle, replacement);
  if (eol === "\r\n") patched = patched.replace(/\n/g, "\r\n");
  writeFileSync(backendPath, patched);
  console.log("[copy-assets] Patched parakeet.js initOrt to honor wasmPaths");
}

patchParakeetWasmPaths();

// coi-serviceworker provides COOP/COEP headers on static hosts (GitHub Pages)
// that can't send them, keeping cross-origin isolation for SharedArrayBuffer.
// A config prelude is prepended: always use COEP "credentialless" (needed for
// Google Analytics) and skip registration when real headers already isolated
// the page (local dev / self-hosting with a proper server).
const coiSrc = join(root, "node_modules/coi-serviceworker/coi-serviceworker.js");
const coiPrelude =
  'if (typeof window !== "undefined") {\n' +
  "  window.coi = {\n" +
  "    coepCredentialless: () => true,\n" +
  "    shouldRegister: () => !window.crossOriginIsolated,\n" +
  "  };\n" +
  "}\n";
writeFileSync(
  join(root, "public/coi-serviceworker.js"),
  coiPrelude + readFileSync(coiSrc, "utf8")
);

// Metadata-only AAF scaffold for Pro Tools / Logic timeline export.
const aafSrc = join(root, "assets/aaf");
const aafDst = join(root, "public/vendor/aaf");
mkdirSync(aafDst, { recursive: true });
for (const f of readdirSync(aafSrc)) {
  cpSync(join(aafSrc, f), join(aafDst, f));
}

console.log(
  "[copy-assets] ffmpeg core + onnxruntime wasm + coi-serviceworker + aaf scaffold copied to public/"
);
