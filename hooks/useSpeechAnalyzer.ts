"use client";

import { useCallback, useEffect, useState } from "react";

export type SpeechAnalyzerAvailability =
  | { status: "unknown" }
  | { status: "unavailable"; reason?: string }
  | { status: "available"; locale?: string };

function initialAvailability(): SpeechAnalyzerAvailability {
  if (typeof window === "undefined") return { status: "unknown" };
  const desktop = window.rescriptDesktop;
  if (!desktop?.speechAnalyzer || desktop.platform !== "darwin") {
    return {
      status: "unavailable",
      reason: desktop ? "SpeechAnalyzer requires macOS." : "Desktop app only.",
    };
  }
  return { status: "unknown" };
}

/**
 * Probe whether the Electron SpeechAnalyzer helper is usable on this host.
 * Always reports unavailable in the browser / non-macOS builds.
 */
export function useSpeechAnalyzerAvailability(): SpeechAnalyzerAvailability {
  const [state, setState] = useState<SpeechAnalyzerAvailability>(initialAvailability);

  useEffect(() => {
    const desktop = window.rescriptDesktop;
    if (!desktop?.speechAnalyzer || desktop.platform !== "darwin") return;

    let cancelled = false;
    void desktop.speechAnalyzer.check().then((result) => {
      if (cancelled) return;
      setState(
        result.available
          ? { status: "available", locale: result.locale }
          : { status: "unavailable", reason: result.reason }
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/** Electron File objects often expose an absolute `.path` for disk files. */
function electronFilePath(file: File): string | undefined {
  const path = (file as File & { path?: string }).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Run SpeechAnalyzer on a media file via the desktop bridge. Updates the
 * editor store with progress / words. Caller should only invoke when the
 * selected model is `speechanalyzer` and availability is confirmed.
 */
export function useSpeechAnalyzerTranscriber() {
  const transcribeFile = useCallback(async (file: File) => {
    const desktop = window.rescriptDesktop?.speechAnalyzer;
    if (!desktop) {
      throw new Error("SpeechAnalyzer is only available in the macOS desktop app.");
    }

    const { useEditorStore } = await import("@/lib/store");
    const store = useEditorStore.getState();
    store.setStatus("transcribing");
    store.setProgress({ message: "Starting SpeechAnalyzer…", value: null });

    const stopProgress = desktop.onProgress((progress) => {
      const s = useEditorStore.getState();
      if (s.skipTranscription) return;
      s.setProgress({ message: progress.message, value: progress.value });
    });

    try {
      const path = electronFilePath(file);
      const result = path
        ? await desktop.transcribe({ path })
        : await desktop.transcribe({
            data: await file.arrayBuffer(),
            name: file.name,
          });

      const s = useEditorStore.getState();
      if (s.skipTranscription) return;
      s.setWords(
        result.words.map((w) => ({
          id: w.id,
          text: w.text,
          start: w.start,
          end: w.end,
          speaker: w.speaker,
          deleted: w.deleted,
        }))
      );
      s.setStatus("ready");
      s.setPartialText("");
      s.setProgress({ message: "", value: null });
    } catch (err) {
      const s = useEditorStore.getState();
      if (s.skipTranscription) return;
      s.setError(err instanceof Error ? err.message : "SpeechAnalyzer failed.");
    } finally {
      stopProgress();
    }
  }, []);

  return { transcribeFile };
}
