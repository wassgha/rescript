"use client";

import { useCallback, useEffect, useRef } from "react";
import { isWhisperModel } from "@/lib/models";
import { useEditorStore } from "@/lib/store";
import type { WorkerResponse } from "@/lib/types";

let activeWorker: Worker | null = null;

/** Stop an in-flight Whisper job (e.g. after importing a transcript). */
export function cancelTranscription() {
  activeWorker?.terminate();
  activeWorker = null;
}

/** Owns the transcription web worker and pipes its messages into the store. */
export function useTranscriber() {
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    return () => {
      cancelTranscription();
      workerRef.current = null;
    };
  }, []);

  const transcribe = useCallback((audio: Float32Array, duration: number) => {
    const store = useEditorStore.getState();
    if (!isWhisperModel(store.model)) {
      store.setError("Select Whisper Base or Small to transcribe with Whisper.");
      return;
    }
    const whisperModel = store.model;
    store.setStatus("transcribing");
    store.setProgress({ message: "Loading speech model…", value: null });

    // Always start a fresh worker so a prior cancel can't leave us without one.
    cancelTranscription();
    workerRef.current = new Worker(
      new URL("../workers/transcription.worker.ts", import.meta.url),
      { type: "module" }
    );
    activeWorker = workerRef.current;
    workerRef.current.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const s = useEditorStore.getState();
      // An imported transcript sets skipTranscription; ignore late Whisper results.
      if (s.skipTranscription) return;
      const msg = event.data;
      switch (msg.type) {
        case "progress":
          s.setProgress({ message: msg.message, value: msg.value });
          break;
        case "partial":
          s.setPartialText(msg.text);
          break;
        case "complete":
          s.setWords(msg.words);
          s.setStatus("ready");
          s.setPartialText("");
          break;
        case "error":
          s.setError(msg.message);
          break;
      }
    };
    workerRef.current.onerror = (err) => {
      const s = useEditorStore.getState();
      if (s.skipTranscription) return;
      s.setError(err.message || "Transcription worker crashed.");
    };

    // Transfer a copy so the original stays available for the waveform.
    const copy = audio.slice();
    workerRef.current.postMessage(
      { audio: copy, duration, model: whisperModel },
      [copy.buffer]
    );
  }, []);

  return { transcribe, cancel: cancelTranscription };
}
