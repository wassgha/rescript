/**
 * electron-builder afterPack hook: make sure the native ffmpeg made it into the
 * package, and is executable.
 *
 * extraResources silently copies nothing when `build/ffmpeg/${os}-${arch}` is
 * missing (fetch-ffmpeg not run, or a new arch added to the targets), and the
 * app would then quietly fall back to ffmpeg.wasm for every export — the very
 * memory ceiling the native engine exists to avoid. Fail the build instead.
 *
 * Runs before signing, so the chmod lands before osx-sign touches the file.
 */
// electron-builder loads hooks with require(), so this stays CommonJS.
/* eslint-disable @typescript-eslint/no-require-imports */
const { chmodSync, existsSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const resources =
    electronPlatformName === "darwin" || electronPlatformName === "mas"
      ? join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : join(appOutDir, "resources");
  const bin = join(resources, "ffmpeg", electronPlatformName === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (!existsSync(bin)) {
    throw new Error(
      `[after-pack] native ffmpeg missing at ${bin} — run \`npm run fetch:ffmpeg\` before electron-builder`
    );
  }
  if (electronPlatformName !== "win32") chmodSync(bin, 0o755);
  console.log(`[after-pack] bundled ${bin}`);
};
