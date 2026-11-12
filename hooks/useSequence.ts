"use client";

import { sequenceFor, type Sequence } from "@/lib/sequence";
import { useEditorStore } from "@/lib/store";

/** The live edit in playback order (runs, pieces, per-copy cuts). */
export function useSequence(): Sequence {
  const words = useEditorStore((s) => s.words);
  const manualCuts = useEditorStore((s) => s.manualCuts);
  const copies = useEditorStore((s) => s.copies);
  const duration = useEditorStore((s) => s.duration);
  return sequenceFor(words, manualCuts, copies, duration);
}
