# Releasing Rescript

Releases are built and published automatically by GitHub Actions
(`.github/workflows/release.yml`) whenever you push a `v*.*.*` tag. Each platform
runs on its own runner (macOS / Ubuntu / Windows), and electron-builder uploads
the installers **and** the `latest-*.yml` update manifests to a GitHub Release.
The app's auto-updater (`electron/updater.ts`) reads those manifests straight
from the release — there is no separate update server to maintain.

The desktop build packages the Next.js **static export** (`out/`) inside Electron.
The GitHub Pages web app continues to deploy from `main` via
`.github/workflows/deploy.yml` and is unaffected by desktop releases.

## Cutting a release

From a clean working tree, run one of the cut scripts. Each bumps the version
in `package.json`, makes a `Release vX.Y.Z` commit, creates a matching `vX.Y.Z`
tag, and pushes both — which triggers the release workflow:

```bash
npm run cut:patch   # 0.1.0 -> 0.1.1
npm run cut:minor   # 0.1.0 -> 0.2.0
npm run cut:major   # 0.1.0 -> 1.0.0
```

> These wrap `npm version <type> && git push --follow-tags`. `npm version`
> refuses to run with uncommitted changes, so commit your work first.

Then watch the build at <https://github.com/wassgha/rescript/actions>.
electron-builder uploads installers to a **draft** GitHub Release while the
three platform jobs run. Once they all succeed, the `publish` job writes
AI-generated release notes (from the diff since the previous tag) and flips
the release to **published**. Auto-update only picks up published releases.

To preview notes for unreleased commits on your machine:

```bash
npm run notes:preview   # needs AI_GATEWAY_API_KEY in .env
```

## Required GitHub secrets

Set these under **Settings → Secrets and variables → Actions**.
A single Developer ID cert + App Store Connect API key works across app IDs.

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | base64-encoded Developer ID Application `.p12` certificate |
| `CSC_KEY_PASSWORD` | password for that `.p12` |
| `APPLE_API_KEY` | base64-encoded App Store Connect API key (`.p8`) — used for notarization |
| `APPLE_API_KEY_ID` | the API key's 10-character Key ID |
| `APPLE_API_ISSUER` | the API key's Issuer ID (UUID) |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key — generates release notes in the publish job (optional; skipped if unset) |

`GITHUB_TOKEN` is provided automatically by Actions — no setup needed.

> Windows and Linux builds are currently **unsigned**. To sign Windows later,
> add a code-signing cert and pass `CSC_LINK`/`CSC_KEY_PASSWORD` to the
> Windows job (electron-builder picks them up the same way).

## Windows arm64

`build.win` targets both `x64` and `arm64`, cross-built from the same x64
runner — the app has no native modules (`--config.npmRebuild=false`), so
electron-builder just fetches the arm64 Electron and packs it.

Both architectures ship inside **one** `Rescript-Setup.exe`, which is
electron-builder's default for NSIS with more than one arch: `NsisTarget`
combines them unless `nsis.buildUniversalInstaller` is `false`. That keeps the
download URL, the artifact name and the update manifests exactly as they were,
at the cost of a roughly twice-as-large installer. Splitting them would mean
adding `${arch}` to `nsis.artifactName` — without it the two builds collide on
one output path — which renames the file every existing download link points at.

An arm64 build matters beyond speed: running the x64 build under Windows-on-Arm
emulation can leave V8 without the SSE4.1 it requires to enable Wasm SIMD, and
every wasm binary the app ships is a SIMD build, so the editor cannot start at
all. See `lib/wasmFeatures.ts`.

## Native ffmpeg

The desktop app extracts audio and renders exports with a bundled static
ffmpeg run from the main process (`electron/media.ts`), not ffmpeg.wasm — the
wasm heap caps out at 2 GiB and holds the whole render in memory, which is what
made long and high-resolution desktop exports fail.

`npm run dist` / `npm run release` run `npm run fetch:ffmpeg` first, which
downloads the pinned [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)
release for every arch the current OS builds (mac: x64 + arm64; win: x64, also
used for arm64 under emulation; linux: x64), checks it against the SHA-256
digests in `scripts/fetch-ffmpeg.mjs`, and writes it to
`build/ffmpeg/<os>-<arch>/` (gitignored). `build.extraResources` copies the
matching one into `resources/ffmpeg/`, and `scripts/after-pack.cjs` fails the
build if it's missing. osx-sign signs it with the rest of the bundle.

The binaries are GPL builds; their LICENSE and README ship next to them. To
move to a newer upstream release, update `RELEASE_TAG` and the digests
(`gh api repos/eugeneware/ffmpeg-static/releases/tags/<tag>` lists them).

If the bundled binary is missing or won't start on a user's machine, the app
falls back to ffmpeg.wasm and reports `stage=native-media-fallback` to Sentry.
`RESCRIPT_MEDIA_ENGINE=wasm` forces the wasm engine; `RESCRIPT_FFMPEG_PATH`
points at a specific binary.

## How signing & notarization work (macOS)

- `build.mac` in `package.json` sets `hardenedRuntime: true`, points at
  `build/entitlements.mac.plist`, and `notarize: true`.
- electron-builder imports `CSC_LINK` to sign the app, then submits the build
  to Apple for notarization using the `APPLE_API_*` credentials and staples
  the ticket.
- The entitlements allow JIT/WASM (Whisper + ffmpeg.wasm), network access
  (first-run model download from Hugging Face), and user-selected file access.

## Testing the build locally (unsigned)

```bash
npm run dist          # static-export Next, bundle electron main, build installers into dist/
```

The Electron main/preload process is bundled with esbuild (`scripts/build-electron.mjs`)
so the installer does **not** ship the Next.js / transformers / ffmpeg `node_modules`
tree — those assets already live inside the static `out/` export. Auto-update is
disabled in `npm run electron:dev` and only runs in packaged builds
(`app.isPackaged`).

## Notes

- App icons live in `build/` (`icon.png` ≥512px). electron-builder derives
  `.icns` / `.ico` from it.
- Desktop builds set `NEXT_PUBLIC_ELECTRON=1` so the static export skips the
  COI service worker (headers come from the `app://` protocol). Google Analytics
  still loads in the desktop app the same as on the web.
