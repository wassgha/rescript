"use client";

import { useCallback, useEffect, useRef } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useEditorStore } from "@/lib/store";
import { getCutRanges, isWordCutOut } from "@/lib/edits";
import { extractAudio, getFFmpeg, releaseFFmpeg } from "@/lib/ffmpeg";
import { VAD_SAMPLE_RATE } from "@/lib/vad";
import { isNetworkError } from "@/lib/network";
import { isElectron } from "@/lib/platform";
import { reportError } from "@/lib/sentry";
import { startSessionReporting } from "@/lib/telemetry";
import { useCrossOriginIsolated } from "@/hooks/useCrossOriginIsolated";
import { useDesktopMenu } from "@/hooks/useDesktopMenu";
import { useIsDesktopLayout } from "@/hooks/useIsDesktopLayout";
import { useTranscriber } from "@/hooks/useTranscriber";
import { detectMediaKind, MEDIA_ACCEPT } from "@/lib/media";
import TopBar from "./TopBar";
import DesktopAppBanner from "./DesktopAppBanner";
import UploadScreen from "./UploadScreen";
import TranscriptPanel from "./TranscriptPanel";
import MediaPreview from "./MediaPreview";
import Timeline from "./Timeline";
import ExportDialog from "./ExportDialog";
import { Download, Redo2, Undo2 } from "lucide-react";
import SettingsMenu from "./SettingsMenu";
import ModelSelector, {
  LanguageSection,
  ModelOption,
  ModelOptionSeparator,
} from "./ModelSelector";
import ImportTranscriptOption from "./ImportTranscriptOption";
import { MODEL_ORDER } from "@/lib/models";
import { isTypingTarget } from "@/lib/keyboard";
import { useI18n } from "./I18nProvider";

/** Transcript and preview split, resizable in both orientations. Wide screens
 *  put the transcript first (left of the preview); stacked screens lead with
 *  the preview on top. Each orientation remembers its own sizes. */
function SplitWorkspace({ orientation }: { orientation: "horizontal" | "vertical" }) {
  const horizontal = orientation === "horizontal";
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `editor-workspace-${orientation}`,
    storage: typeof window !== "undefined" ? localStorage : undefined,
  });

  const preview = (
    <Panel
      id="media"
      defaultSize={horizontal ? "44%" : "34vh"}
      minSize={horizontal ? 320 : 140}
      className="flex min-h-0 min-w-0 flex-col"
    >
      <MediaPreview />
    </Panel>
  );
  const transcript = (
    <Panel
      id="transcript"
      defaultSize={horizontal ? "56%" : "66%"}
      minSize={horizontal ? "20%" : 160}
      className="flex min-h-0 min-w-0 flex-col"
    >
      <TranscriptPanel />
    </Panel>
  );
  const separator = (
    <Separator
      className={`${horizontal ? "w-px" : "h-px"} bg-zinc-200 outline-none transition-colors hover:bg-zinc-300 data-[separator=active]:bg-zinc-300 data-[separator=focus]:bg-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:data-[separator=active]:bg-zinc-700 dark:data-[separator=focus]:bg-zinc-700`}
    />
  );

  return (
    <Group
      orientation={orientation}
      className="min-h-0 flex-1"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      // The hairline divider is too small to hit with a finger; widen the
      // touch target well past its visual size.
      resizeTargetMinimumSize={{ coarse: 32, fine: 10 }}
    >
      {horizontal ? (
        <>
          {transcript}
          {separator}
          {preview}
        </>
      ) : (
        <>
          {preview}
          {separator}
          {transcript}
        </>
      )}
    </Group>
  );
}

function EditorWorkspace() {
  const isDesktop = useIsDesktopLayout();
  const mediaKind = useEditorStore((s) => s.mediaKind);
  // Audio has no visual preview — give the transcript the full workspace and
  // mount MediaPreview off-layout so the hidden <audio> element still drives
  // playback / spacebar / timeline controls.
  if (mediaKind === "audio") {
    return (
      <>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TranscriptPanel />
        </div>
        <MediaPreview />
      </>
    );
  }
  // Keyed so crossing the breakpoint remounts the group and restores that
  // orientation's saved layout instead of carrying sizes across.
  return isDesktop ? (
    <SplitWorkspace key="horizontal" orientation="horizontal" />
  ) : (
    <SplitWorkspace key="vertical" orientation="vertical" />
  );
}

export default function Editor() {
  const { t } = useI18n();
  const status = useEditorStore((s) => s.status);
  const videoFile = useEditorStore((s) => s.videoFile);
  const skipTranscription = useEditorStore((s) => s.skipTranscription);
  const loadVideo = useEditorStore((s) => s.loadVideo);
  const { transcribe } = useTranscriber();

  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const setExportOpen = useEditorStore((s) => s.setExportOpen);

  // File › Open Project… reaches the same picker the upload screen uses, from
  // anywhere in the app.
  const menuInputRef = useRef<HTMLInputElement>(null);
  const isolation = useCrossOriginIsolated();
  const isolated = isolation === "ready";
  const openFilePicker = useCallback(() => menuInputRef.current?.click(), []);
  useDesktopMenu(openFilePicker, isolated);

  const startMenuFile = useCallback(
    (file: File) => {
      const { source, pendingTranscript } = useEditorStore.getState();
      if (source === "import") {
        if (!pendingTranscript) {
          alert(t("editor.chooseTranscript"));
          return;
        }
        loadVideo(file, {
          words: pendingTranscript.words,
          speakers: pendingTranscript.speakers,
        });
        return;
      }
      loadVideo(file);
    },
    [loadVideo, t]
  );

  // The pipeline needs SharedArrayBuffer, so a file picked before the page is
  // cross-origin isolated waits here instead of failing on load.
  const deferredFile = useRef<File | null>(null);
  const startMenuFileRef = useRef(startMenuFile);
  useEffect(() => {
    startMenuFileRef.current = startMenuFile;
  }, [startMenuFile]);
  useEffect(() => {
    if (!isolated || !deferredFile.current) return;
    const file = deferredFile.current;
    deferredFile.current = null;
    startMenuFileRef.current(file);
  }, [isolated]);

  const handleMenuFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      if (!detectMediaKind(file)) {
        alert(t("editor.chooseMedia"));
        return;
      }
      if (!isolated) {
        deferredFile.current = file;
        return;
      }
      startMenuFile(file);
    },
    [isolated, startMenuFile, t]
  );

  // Daily-active signal: reports the launch, then again on each day rollover so
  // a long-running window doesn't look churned.
  useEffect(() => startSessionReporting(), []);

  // Processing pipeline: load ffmpeg -> extract audio -> (maybe) transcribe.
  // Restored projects already have words; they only need PCM for the waveform.
  const startedFor = useRef<File | null>(null);
  useEffect(() => {
    if (!videoFile || startedFor.current === videoFile) return;
    startedFor.current = videoFile;
    const restoreOnly = useEditorStore.getState().skipTranscription;
    (async () => {
      const s = useEditorStore.getState();
      try {
        s.setProgress({ message: "Loading media engine…", value: null });
        await getFFmpeg();
        s.setProgress({ message: "Extracting audio…", value: null });
        const audio = await extractAudio(videoFile);
        s.setAudio(audio);
        // ffmpeg's gigabyte is pure overhead from here until the user exports,
        // and holding it through model instantiation is what makes WebKit kill
        // the tab. Export re-initialises it lazily from the HTTP cache.
        await releaseFFmpeg();
        if (restoreOnly || !audio) {
          s.setStatus("ready");
          s.setProgress({ message: "", value: null });
        } else {
          transcribe(audio, audio.length / VAD_SAMPLE_RATE);
        }
      } catch (err) {
        console.error("Processing pipeline failed:", err);
        // Same reasoning as the worker's error path: a dropped connection while
        // pulling the media engine is the user's network, not a bug, and
        // "Failed to fetch" tells them nothing about what to do next.
        if (isNetworkError(err)) {
          s.setError(
            "Couldn't load the media engine — the connection dropped. " +
              "Check your internet and try again."
          );
          return;
        }
        reportError(err, "media-pipeline");
        s.setError(err instanceof Error ? err.message : "Failed to process this file.");
      }
    })();
  }, [videoFile, skipTranscription, transcribe]);

  // The main process uses this mode only to preserve the native close behavior
  // (close project first, then close the upload window). It no longer resizes
  // the window; user-chosen bounds are persisted by Electron instead.
  useEffect(() => {
    window.rescriptDesktop?.setWindowMode(status === "idle" ? "compact" : "expanded");
  }, [status]);

  // Global shortcuts: space = play/pause, ⌘Z / ⇧⌘Z = undo / redo, S = split,
  // Delete/Backspace = delete selected clip or restore selected cut / cut words.
  // Capture phase so Space is ours before a focused <button> synthesizes a click
  // (which would double-toggle playback and look like the hotkey "didn't work").
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const s = useEditorStore.getState();
      if (e.code === "Space" && s.videoEl && !s.exportOpen) {
        e.preventDefault();
        e.stopPropagation();
        s.togglePlayback();
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
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        s.status === "ready" &&
        !s.exportOpen
      ) {
        // Cut region selected → restore it (also covers cut words clicked on
        // the timeline, which select their cut). Kept words → cut them. Clip
        // selected with no words → delete the clip.
        if (s.selectedCutIndex != null) {
          e.preventDefault();
          e.stopPropagation();
          s.restoreSelectedCut();
          return;
        }
        if (s.selectedWordIds.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const cuts = getCutRanges(s.words, s.duration, s.manualCuts);
          const selected = s.words.filter((w) => s.selectedWordIds.includes(w.id));
          const allCutOut =
            selected.length > 0 && selected.every((w) => isWordCutOut(w, cuts));
          if (allCutOut) s.restoreWords(s.selectedWordIds);
          else s.deleteWords(s.selectedWordIds);
          s.setSelectedWords([]);
          return;
        }
        if (s.selectedClipIndex != null) {
          e.preventDefault();
          e.stopPropagation();
          s.deleteSelectedClip();
        }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
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
    <div className="relative flex h-dvh flex-col overflow-hidden bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <DesktopAppBanner />
      {status === "idle" ? (
        <>
          {isElectron && <TopBar>
            <ModelSelector groupLabel={t("model.transcriptSource")}>
              {MODEL_ORDER.map((id) => (
                <ModelOption key={id} id={id} />
              ))}
              <ModelOptionSeparator />
              <LanguageSection />
              <ModelOptionSeparator />
              <ImportTranscriptOption />
            </ModelSelector>
            <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
            <SettingsMenu />
          </TopBar>}
          <UploadScreen onFile={loadVideo} />
        </>
      ) : (
        <>
          <TopBar>
            <button
              onClick={undo}
              disabled={!canUndo}
              title={t("editor.undo")}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <Undo2 size={16} />
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              title={t("editor.redo")}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <Redo2 size={16} />
            </button>
            <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
            <button
              onClick={() => setExportOpen(true)}
              disabled={status !== "ready" && status !== "exporting"}
              className="flex ml-1 h-8 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white transition hover:bg-zinc-700 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              <Download size={14} />
              {t("editor.export")}
            </button>
            <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
            <SettingsMenu />
          </TopBar>
          <EditorWorkspace />
          <Timeline />
        </>
      )}
      {isElectron && (
        // Present in the layout tree (not display:none) so the native menu's
        // click() reliably opens the picker.
        <input
          ref={menuInputRef}
          type="file"
          accept={MEDIA_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            handleMenuFile(e.target.files?.[0]);
            // Allow re-picking the same file after a "start over".
            e.target.value = "";
          }}
        />
      )}
      <ExportDialog />
    </div>
  );
}
