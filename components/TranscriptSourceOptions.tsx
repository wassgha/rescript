"use client";

import { useEffect } from "react";
import { SPEECH_ANALYZER_INFO } from "@/lib/models";
import { useEditorStore } from "@/lib/store";
import { useSpeechAnalyzerAvailability } from "@/hooks/useSpeechAnalyzer";
import { ModelOption, ModelOptionSeparator } from "./ModelSelector";
import ImportTranscriptOption from "./ImportTranscriptOption";

/**
 * The transcript-source rows shared by both ModelSelector call sites: the
 * upload screen's inline header (web) and the Electron title bar. Keeping them
 * in one component means a new backend only has to be added once.
 *
 * SpeechAnalyzer only appears once the Electron helper reports itself usable,
 * so web builds and non-macOS desktops see just Whisper + import.
 */
export default function TranscriptSourceOptions() {
  const speechAnalyzer = useSpeechAnalyzerAvailability();
  const model = useEditorStore((s) => s.model);
  const setModel = useEditorStore((s) => s.setModel);

  // A persisted "speechanalyzer" preference can outlive the helper (moved to a
  // web build, downgraded macOS, helper removed) — fall back to Whisper.
  useEffect(() => {
    if (speechAnalyzer.status === "unavailable" && model === "speechanalyzer") {
      setModel("base");
    }
  }, [speechAnalyzer.status, model, setModel]);

  return (
    <>
      <ModelOption id="base" />
      <ModelOption id="small" />
      {speechAnalyzer.status === "available" && (
        <>
          <ModelOptionSeparator />
          <ModelOption
            id="speechanalyzer"
            label={SPEECH_ANALYZER_INFO.label}
            meta={SPEECH_ANALYZER_INFO.size}
          >
            <span className="pl-[1.625rem] text-[11px] leading-snug text-zinc-400">
              {SPEECH_ANALYZER_INFO.description}
            </span>
          </ModelOption>
        </>
      )}
      <ModelOptionSeparator />
      <ImportTranscriptOption />
    </>
  );
}
