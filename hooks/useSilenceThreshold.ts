"use client";

import { useCallback, useState } from "react";
import {
  clampSilenceThreshold,
  loadSilenceThreshold,
  saveSilenceThreshold,
} from "@/lib/silenceThreshold";

/**
 * "Remove silences" threshold preference (seconds, default 0.3). Safe to read
 * in the initializer because the whole editor tree is client-only (`ssr: false`).
 */
export function useSilenceThreshold() {
  const [threshold, setThresholdState] = useState(() => loadSilenceThreshold());

  const setThreshold = useCallback((next: number) => {
    const clamped = clampSilenceThreshold(next);
    saveSilenceThreshold(clamped);
    setThresholdState(clamped);
  }, []);

  return { threshold, setThreshold };
}
