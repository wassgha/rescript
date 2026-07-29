"use client";

import { useEffect, useRef, useState } from "react";
import { isSpeechAnalyzerModel, isWhisperModel } from "@/lib/models";
import { useEditorStore } from "@/lib/store";
import { extractAudio, getFFmpeg } from "@/lib/ffmpeg";
import { useTranscriber } from "@/hooks/useTranscriber";
import { useSpeechAnalyzerTranscriber } from "@/hooks/useSpeechAnalyzer";
import TopBar from "./TopBar";
import UploadScreen from "./UploadScreen";
import TranscriptPanel from "./TranscriptPanel";
import MediaPreview from "./MediaPreview";
import Timeline from "./Timeline";
import ExportDialog from "./ExportDialog";
import GitHubLink from "./GitHubLink";
import { Download, Redo2, Undo2 } from "lucide-react";
import ModelSelector from "./ModelSelector";
import TranscriptSourceOptions from "./TranscriptSourceOptions";
import LogoLoader from "./LogoLoader";

/** How long the desktop mode-change overlay stays up. Matches the macOS
 *  `setBounds(..., animate)` duration plus a small buffer so the layout
 *  underneath isn't revealed mid-resize. */
const WINDOW_MODE_OVERLAY_MS = 380;

export default function Editor() {
  const status = useEditorStore((s) => s.status);
  const videoFile = useEditorStore((s) => s.videoFile);
  const skipTranscription = useEditorStore((s) => s.skipTranscription);
  const loadVideo = useEditorStore((s) => s.loadVideo);
  const { transcribe } = useTranscriber();
  const { transcribeFile: transcribeSpeechAnalyzer } = useSpeechAnalyzerTranscriber();

  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const setExportOpen = useEditorStore((s) => s.setExportOpen);

  const isElectron = /electron/i.test(navigator.userAgent);
  const [modeTransitioning, setModeTransitioning] = useState(false);
  const wasIdle = useRef(status === "idle");

  // Processing pipeline: load ffmpeg -> extract audio -> (maybe) transcribe.
  // Restored projects already have words; they only need PCM for the waveform.
  // SpeechAnalyzer runs in the Electron main process (skips the Whisper worker).
  const startedFor = useRef<File | null>(null);
  useEffect(() => {
    if (!videoFile || startedFor.current === videoFile) return;
    startedFor.current = videoFile;
    const restoreOnly = useEditorStore.getState().skipTranscription;
    const model = useEditorStore.getState().model;
    (async () => {
      const s = useEditorStore.getState();
      try {
        s.setProgress({ message: "Loading media engine…", value: null });
        await getFFmpeg();
        s.setProgress({ message: "Extracting audio…", value: null });
        const audio = await extractAudio(videoFile);
        s.setAudio(audio);
        if (restoreOnly) {
          s.setStatus("ready");
          s.setProgress({ message: "", value: null });
        } else if (isSpeechAnalyzerModel(model)) {
          await transcribeSpeechAnalyzer(videoFile);
        } else if (isWhisperModel(model)) {
          transcribe(audio, audio.length / 16000);
        } else {
          s.setError("Select a transcript source before dropping media.");
        }
      } catch (err) {
        console.error("Processing pipeline failed:", err);
        s.setError(err instanceof Error ? err.message : "Failed to process this file.");
      }
    })();
  }, [videoFile, skipTranscription, transcribe, transcribeSpeechAnalyzer]);

  // The desktop shell opens as a small upload window and grows once the
  // three-pane editor takes over (and shrinks back on "start over").
  // Cover the swap with a brief overlay so the layout reflow isn't visible
  // while the window animates between sizes.
  useEffect(() => {
    const idle = status === "idle";
    window.rescriptDesktop?.setWindowMode(idle ? "compact" : "expanded");
    if (!isElectron || wasIdle.current === idle) return;
    wasIdle.current = idle;
    setModeTransitioning(true);
    const timer = window.setTimeout(() => setModeTransitioning(false), WINDOW_MODE_OVERLAY_MS);
    return () => window.clearTimeout(timer);
  }, [status, isElectron]);

  // Global shortcuts: space = play/pause, ⌘Z / ⇧⌘Z = undo / redo, S = split.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;
      const s = useEditorStore.getState();
      if (e.code === "Space" && s.videoEl && !s.exportOpen) {
        e.preventDefault();
        if (s.videoEl.paused) void s.videoEl.play();
        else s.videoEl.pause();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (
        e.key.toLowerCase() === "s" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        s.status === "ready" &&
        !s.exportOpen
      ) {
        e.preventDefault();
        s.splitAtPlayhead();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Flush pending autosave when the tab hides or unloads.
  useEffect(() => {
    const flush = () => {
      void import("@/lib/autosave").then((m) => m.flushProjectAutosave());
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-zinc-50 text-zinc-900">
      {status === "idle" ? (
        <>
          {isElectron && <TopBar>
            <ModelSelector groupLabel="Transcript source">
              <TranscriptSourceOptions />
            </ModelSelector>
          </TopBar>}
          <UploadScreen onFile={loadVideo} />
        </>
      ) : (
        <>
          <TopBar>
            <GitHubLink />
            <button
              onClick={undo}
              disabled={!canUndo}
              title="Undo (⌘Z)"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <Undo2 size={16} />
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              title="Redo (⇧⌘Z)"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <Redo2 size={16} />
            </button>
            <div className="mx-1 h-5 w-px bg-zinc-200" />
            <button
              onClick={() => setExportOpen(true)}
              disabled={status !== "ready" && status !== "exporting"}
              className="flex h-8 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download size={14} />
              Export
            </button>
          </TopBar>
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <div className="order-1 flex h-[34vh] shrink-0 flex-col border-b border-zinc-200 lg:order-2 lg:h-auto lg:w-[44%] lg:min-w-[320px] lg:border-b-0 lg:border-l">
              <MediaPreview />
            </div>
            <div className="order-2 flex min-h-0 flex-1 lg:order-1">
              <TranscriptPanel />
            </div>
            {/* <SideRail /> — hidden until the tools it exposes are functional */}
          </div>
          <Timeline />
        </>
      )}
      {modeTransitioning && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-50"
          aria-busy="true"
          aria-live="polite"
        >
          <LogoLoader size={44} />
        </div>
      )}
      <ExportDialog />
    </div>
  );
}
