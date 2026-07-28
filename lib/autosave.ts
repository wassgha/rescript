/**
 * Debounced autosave of the current editor project into IndexedDB.
 */

import { useEditorStore } from "./store";
import { getProject, putProject } from "./projects";

const DEBOUNCE_MS = 500;

let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let queued = false;

export function scheduleProjectAutosave() {
  if (typeof window === "undefined") return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushProjectAutosave();
  }, DEBOUNCE_MS);
}

/** Flush any pending debounce and wait for the write to finish. */
export async function flushProjectAutosave(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (inflight) {
    queued = true;
    await inflight;
    if (queued) await flushProjectAutosave();
    return;
  }

  inflight = writeSnapshot();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
  if (queued) {
    queued = false;
    await flushProjectAutosave();
  }
}

async function writeSnapshot() {
  const s = useEditorStore.getState();
  if (s.status !== "ready") return;
  if (!s.videoFile || !s.mediaKind || s.words.length === 0) return;

  try {
    let createdAt: number | undefined;
    if (s.projectId) {
      const existing = await getProject(s.projectId);
      createdAt = existing?.createdAt;
    }
    const id = await putProject({
      id: s.projectId ?? undefined,
      name: s.videoFile.name,
      mediaKind: s.mediaKind,
      duration: s.duration,
      model: s.model,
      words: s.words,
      showDeleted: s.showDeleted,
      cutAdjustments: s.cutAdjustments,
      media: s.videoFile,
      mediaType: s.videoFile.type,
      createdAt,
    });
    if (useEditorStore.getState().projectId !== id) {
      useEditorStore.setState({ projectId: id });
    }
  } catch (err) {
    console.warn("Failed to autosave project.", err);
  }
}
