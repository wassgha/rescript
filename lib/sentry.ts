import * as Sentry from "@sentry/react";
import { isElectron } from "./platform";
import { isTelemetryEnabled } from "./telemetry";

/**
 * Crash reporting for the renderer (web app and Electron alike).
 *
 * Governed by the same opt-out as usage telemetry: if "Help improve the app" is
 * off, the SDK is never initialised, so nothing is captured and nothing is sent.
 */

const MEDIA_EXT =
  "mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac|flac|ogg|opus|srt|vtt|json|txt|md";

/**
 * Keep the directory shape, replace only the account-name segment: knowing a
 * failure happened under Movies vs Downloads is useful, knowing *whose* isn't.
 */
const USER_DIR_RE = new RegExp(
  String.raw`((?:\/Users|\/home|[A-Za-z]:\\Users)[\/\\])[^\/\\\s'"]+`,
  "g"
);

/**
 * Filenames containing spaces realistically show up quoted. Path separators are
 * excluded from the inner class so a quoted *path* falls through to USER_DIR_RE
 * and FILENAME_RE instead of being swallowed whole.
 */
const QUOTED_FILE_RE = new RegExp(
  String.raw`(['"])([^'"\/\\]*\.(?:${MEDIA_EXT}))\1`,
  "gi"
);

/**
 * Bare filename token, bounded by whitespace, quotes, or separators. Bounding
 * matters: an earlier version allowed spaces in the stem and greedily ate the
 * words before the name, turning "Could not parse interview.srt" into just
 * "<filename>" — which would collapse every import failure into one
 * indistinguishable Sentry group.
 */
const FILENAME_RE = new RegExp(
  String.raw`[^\s\/\\'"<>|]*\.(?:${MEDIA_EXT})\b`,
  "gi"
);

/** `blob:` and `file:` URLs can both identify the user's media. */
const URL_RE = /\b(?:blob|file):[^\s"')]+/gi;

/**
 * Redact user-identifying substrings from any free-text field we send, while
 * leaving enough of the message to group and act on. Idempotent.
 */
export function scrubText(input: string): string {
  return input
    .replace(URL_RE, "<url>")
    .replace(USER_DIR_RE, "$1<user>")
    .replace(QUOTED_FILE_RE, (_match, quote: string) => `${quote}<filename>${quote}`)
    .replace(FILENAME_RE, "<filename>");
}

/** Recursively scrub the string leaves of a breadcrumb/event payload. */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        scrubDeep(v, depth + 1),
      ])
    );
  }
  return value;
}

/** Noise we can never act on, so it only costs quota and attention. */
const IGNORE_ERRORS = [
  // Benign layout-loop warning browsers surface as an error event.
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
  // Extensions and injected scripts, not our code.
  /^Non-Error promise rejection captured/,
  /chrome-extension:\/\//,
  /moz-extension:\/\//,
];

export function initSentry() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  // No DSN in local dev or a fork's build — stay entirely inert rather than
  // warn, so contributors don't need Sentry credentials to run the app.
  if (!dsn) return;
  if (!isTelemetryEnabled()) return;

  Sentry.init({
    dsn,
    release: process.env.NEXT_PUBLIC_APP_VERSION,
    environment: process.env.NODE_ENV,
    // Never attach IP address, cookies, or headers.
    sendDefaultPii: false,
    tracesSampleRate: 0,
    ignoreErrors: IGNORE_ERRORS,
    initialScope: {
      tags: { surface: isElectron ? "desktop" : "web" },
    },

    beforeBreadcrumb(breadcrumb) {
      // Console breadcrumbs forward whatever was passed to console.error, which
      // in this codebase is often a raw error from ffmpeg or IndexedDB. Keep the
      // fact that it happened; scrub the payload.
      if (breadcrumb.message) breadcrumb.message = scrubText(breadcrumb.message);
      if (breadcrumb.data) {
        breadcrumb.data = scrubDeep(breadcrumb.data) as Record<string, unknown>;
      }
      return breadcrumb;
    },

    beforeSend(event) {
      for (const value of event.exception?.values ?? []) {
        if (value.value) value.value = scrubText(value.value);
      }
      if (event.message) event.message = scrubText(event.message);
      // Blob URLs of the loaded media end up here on the web build.
      if (event.request?.url) event.request.url = scrubText(event.request.url);
      if (event.extra) {
        event.extra = scrubDeep(event.extra) as Record<string, unknown>;
      }
      return event;
    },
  });
}

/**
 * Report a handled failure that the UI already surfaced to the user. The message
 * shown to them is deliberately friendly and lossy, so send the underlying error
 * with a tag describing where the pipeline gave up.
 */
export function reportError(error: unknown, stage: string) {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  if (!isTelemetryEnabled()) return;
  // Native media errors carry ffmpeg's stderr tail — the only record of what
  // actually went wrong. Scrubbed of paths by beforeSend like any other extra.
  const detail =
    error && typeof error === "object" && "detail" in error
      ? (error as { detail?: unknown }).detail
      : undefined;
  Sentry.captureException(error, {
    tags: { stage },
    ...(typeof detail === "string" ? { extra: { detail } } : {}),
  });
}
