import { MIN_SILENCE_DURATION } from "./silences";

/**
 * User-adjustable "Remove silences" threshold (seconds). Persisted like
 * appearance/telemetry (see `theme.ts`) — a simple opt-in preference, not part
 * of a project, so every project uses whatever the user last set.
 */
const STORAGE_KEY = "rescript.silence-threshold";

/** Below this, inter-word ASR spacing would get cut too — same floor the request asked for. */
export const MIN_SILENCE_THRESHOLD = 0.1;
/** Above this a "silence" starts swallowing real pauses in speech. */
export const MAX_SILENCE_THRESHOLD = 2;
/** Unset preference: the editor's long-standing built-in cutoff. */
export const DEFAULT_SILENCE_THRESHOLD: number = MIN_SILENCE_DURATION;

/** Clamp to the supported range; invalid input (NaN/±Infinity) falls back to the default. */
export function clampSilenceThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SILENCE_THRESHOLD;
  return Math.min(MAX_SILENCE_THRESHOLD, Math.max(MIN_SILENCE_THRESHOLD, value));
}

/** Read the stored threshold (defaults to {@link DEFAULT_SILENCE_THRESHOLD}). */
export function loadSilenceThreshold(): number {
  if (typeof window === "undefined") return DEFAULT_SILENCE_THRESHOLD;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_SILENCE_THRESHOLD;
    return clampSilenceThreshold(Number(raw));
  } catch {
    // Private mode / disabled storage.
    return DEFAULT_SILENCE_THRESHOLD;
  }
}

export function saveSilenceThreshold(value: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampSilenceThreshold(value)));
  } catch {
    // Preference just won't persist; not worth surfacing.
  }
}

// Module-level cache plus subscribers, so every `useSilenceThreshold()` call
// (Settings slider, Tools menu label, ...) sees the same value right away
// instead of each component keeping its own `useState` copy until remount.
let cached: number | null = null;
const listeners = new Set<() => void>();

function readCached(): number {
  if (cached == null) cached = loadSilenceThreshold();
  return cached;
}

export function getSilenceThreshold(): number {
  return readCached();
}

export function setSilenceThresholdShared(value: number): number {
  const clamped = clampSilenceThreshold(value);
  cached = clamped;
  saveSilenceThreshold(clamped);
  for (const listener of listeners) listener();
  return clamped;
}

export function subscribeSilenceThreshold(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
