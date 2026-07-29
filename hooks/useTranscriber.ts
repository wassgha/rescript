"use client";

import { useCallback, useEffect, useRef } from "react";
import { alignTranscript } from "@/lib/alignTranscript";
import { isWhisperModel, loadModelPreference } from "@/lib/models";
import { useEditorStore } from "@/lib/store";
import type { WorkerResponse } from "@/lib/types";

let activeWorker: Worker | null = null;

/** Stop an in-flight Whisper job (e.g. after importing a transcript). */
export function cancelTranscription() {
  activeWorker?.terminate();
  activeWorker = null;
}

/**
 * Run Whisper (and optional plain-text sync) against PCM already in the store
 * pipeline. Shared by the Editor mount path and mid-session TXT import.
 */
export function startTranscription(audio: Float32Array, duration: number) {
  const store = useEditorStore.getState();
  const syncing = Boolean(store.syncTokens?.length);
  // Plain-text import keeps model === "import" but still needs Whisper for
  // timing; use the last Whisper preference for that sync pass.
  const whisperModel = isWhisperModel(store.model)
    ? store.model
    : syncing
      ? loadModelPreference()
      : null;
  if (!whisperModel) {
    store.setError("Select Whisper Base or Small to transcribe.");
    return;
  }
  store.setStatus("transcribing");
  store.setProgress({
    message: syncing
      ? "Syncing your transcript to the audio…"
      : "Loading speech model…",
    value: null,
  });

  cancelTranscription();
  const worker = new Worker(
    new URL("../workers/transcription.worker.ts", import.meta.url),
    { type: "module" }
  );
  activeWorker = worker;

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const s = useEditorStore.getState();
    // Timed imports set skipTranscription; ignore late Whisper results.
    if (s.skipTranscription) return;
    const msg = event.data;
    switch (msg.type) {
      case "progress":
        s.setProgress({
          message: s.syncTokens?.length
            ? msg.message.replace(/^Transcrib/i, "Syncing")
            : msg.message,
          value: msg.value,
        });
        break;
      case "partial":
        s.setPartialText(msg.text);
        break;
      case "complete": {
        const tokens = s.syncTokens;
        if (tokens && tokens.length > 0) {
          try {
            s.setProgress({ message: "Aligning your transcript…", value: 1 });
            const aligned = alignTranscript(
              tokens,
              msg.words,
              s.duration || duration
            );
            s.setSyncTokens(null);
            s.setWords(aligned);
            s.setStatus("ready");
            s.setPartialText("");
            s.setProgress({ message: "", value: null });
          } catch (err) {
            s.setSyncTokens(null);
            s.setError(
              err instanceof Error
                ? err.message
                : "Could not sync that transcript to the audio."
            );
          }
          break;
        }
        s.setWords(msg.words);
        s.setStatus("ready");
        s.setPartialText("");
        break;
      }
      case "error":
        s.setSyncTokens(null);
        s.setError(msg.message);
        break;
    }
  };
  worker.onerror = (err) => {
    const s = useEditorStore.getState();
    if (s.skipTranscription) return;
    s.setSyncTokens(null);
    s.setError(err.message || "Transcription worker crashed.");
  };

  const copy = audio.slice();
  worker.postMessage(
    { audio: copy, duration, model: whisperModel },
    [copy.buffer]
  );
}

/** Owns the transcription web worker and pipes its messages into the store. */
export function useTranscriber() {
  useEffect(() => {
    return () => {
      cancelTranscription();
    };
  }, []);

  // Keep a ref so Strict Mode remounts don't leave a dangling worker pointer
  // in local state; the module-level activeWorker is the source of truth.
  const workerRef = useRef<Worker | null>(null);
  const transcribe = useCallback((audio: Float32Array, duration: number) => {
    startTranscription(audio, duration);
    workerRef.current = activeWorker;
  }, []);

  return { transcribe, cancel: cancelTranscription };
}
