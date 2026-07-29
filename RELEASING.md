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
- The macOS **SpeechAnalyzer** helper lives under `native/speechanalyzer/`.
  Release builds on `macos-latest` run `make -C native/speechanalyzer build`
  before packaging; the signed binary is copied to `resources/bin/` and shipped
  via electron-builder `extraResources`. Requires Xcode 26 / macOS 26 SDK.
