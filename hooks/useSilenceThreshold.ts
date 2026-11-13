"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_SILENCE_THRESHOLD,
  getSilenceThreshold,
  setSilenceThresholdShared,
  subscribeSilenceThreshold,
} from "@/lib/silenceThreshold";

/**
 * "Remove silences" threshold preference (seconds, default 0.3). Backed by a
 * module-level store (see `silenceThreshold.ts`) so every consumer re-renders
 * together when it changes, not just the component that called `setThreshold`.
 */
export function useSilenceThreshold() {
  const threshold = useSyncExternalStore(
    subscribeSilenceThreshold,
    getSilenceThreshold,
    () => DEFAULT_SILENCE_THRESHOLD
  );

  const setThreshold = useCallback((next: number) => {
    setSilenceThresholdShared(next);
  }, []);

  return { threshold, setThreshold };
}
