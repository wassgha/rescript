"use client";

import { useCallback, useEffect, useRef } from "react";
import { isModelId } from "@/lib/models";
import { reportError } from "@/lib/sentry";
import { useEditorStore } from "@/lib/store";
import { trackEvent } from "@/lib/telemetry";
import type { WorkerResponse } from "@/lib/types";

let activeWorker: Worker | null = null;

const TRANSCRIPTION_SETTINGS_KEY = "rescript.transcription.settings";
const DEFAULT_TRANSCRIPTION_SETTINGS = {
  maxSpeakers: 2,
  onsetThreshold: 0.7,
};

function readTranscriptionSettings() {
  if (typeof window === "undefined" || !window.localStorage) {
    return DEFAULT_TRANSCRIPTION_SETTINGS;
  }
  try {
    const raw = window.localStorage.getItem(TRANSCRIPTION_SETTINGS_KEY);
    if (!raw) return DEFAULT_TRANSCRIPTION_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_TRANSCRIPTION_SETTINGS>;
    return {
      maxSpeakers: Number.isFinite(parsed.maxSpeakers)
        ? Math.max(1, Math.round(Number(parsed.maxSpeakers)))
        : DEFAULT_TRANSCRIPTION_SETTINGS.maxSpeakers,
      onsetThreshold: Number.isFinite(parsed.onsetThreshold)
        ? Math.max(0, Math.min(1, Number(parsed.onsetThreshold)))
        : DEFAULT_TRANSCRIPTION_SETTINGS.onsetThreshold,
    };
  } catch {
    return DEFAULT_TRANSCRIPTION_SETTINGS;
  }
}

/** Stop an in-flight ASR job (e.g. after importing a transcript). */
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
    if (!isModelId(store.source)) {
      store.setError("Select a speech model to transcribe.");
      return;
    }
    const model = store.source;
    const transcriptLanguage = store.transcriptLanguage;
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
      // An imported transcript sets skipTranscription; ignore late ASR results.
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
          // Which model and language actually get used, to prioritise backends.
          // Nothing about the media itself — not its length, not the text.
          trackEvent("transcription_completed", {
            model,
            language: transcriptLanguage,
          });
          break;
        case "error":
          s.setError(msg.message);
          // A connection that dropped mid-download is the user's network, and
          // the worker already retried it. There is no stack to act on, so
          // reporting it only spends quota on an issue we cannot fix.
          if (msg.cause !== "network") {
            // Worker errors cross a postMessage boundary, so the original stack
            // is already gone by here — send the message with a stage tag.
            reportError(new Error(msg.message), "transcription");
          }
          break;
      }
    };
    workerRef.current.onerror = (err) => {
      const s = useEditorStore.getState();
      if (s.skipTranscription) return;
      s.setError(err.message || "Transcription worker crashed.");
      reportError(
        new Error(err.message || "Transcription worker crashed."),
        "transcription-worker"
      );
    };

    const settings = readTranscriptionSettings();

    // Transfer, not copy: the worker takes ownership of the PCM and `audio` is
    // detached here. Nothing on the main thread reads it afterwards — the
    // waveform draws from the envelope the store built in setAudio — and on a
    // long recording the copy this replaces was hundreds of megabytes held for
    // the length of the run.
    workerRef.current.postMessage(
      {
        audio,
        duration,
        model,
        language: transcriptLanguage,
        maxSpeakers: settings.maxSpeakers,
        onsetThreshold: settings.onsetThreshold,
      },
      [audio.buffer]
    );
  }, []);

  return { transcribe, cancel: cancelTranscription };
}
