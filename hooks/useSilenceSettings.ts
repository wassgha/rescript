"use client";

import { useCallback, useState } from "react";
import {
  loadSilenceLength,
  loadSilenceSplit,
  normalizeSilenceLength,
  normalizeSilenceSplit,
  saveSilenceLength,
  saveSilenceSplit,
} from "@/lib/silences";

/** "Shorten silences" length and after/before split, persisted across sessions. */
export function useSilenceSettings() {
  const [length, setLengthState] = useState(loadSilenceLength);
  const [split, setSplitState] = useState(loadSilenceSplit);

  const setLength = useCallback((value: number) => {
    const next = normalizeSilenceLength(value);
    if (next === null) return;
    saveSilenceLength(next);
    setLengthState(next);
  }, []);

  const setSplit = useCallback((value: number) => {
    const next = normalizeSilenceSplit(value);
    if (next === null) return;
    saveSilenceSplit(next);
    setSplitState(next);
  }, []);

  return { length, split, setLength, setSplit };
}
