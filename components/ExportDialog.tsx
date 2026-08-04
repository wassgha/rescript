"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Captions,
  Clapperboard,
  Download,
  FileText,
  Film,
  Music,
  X,
} from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { formatTime, getEditedDuration, getKeepRanges } from "@/lib/edits";
import {
  exportAudio,
  exportVideo,
  type AudioExportFormat,
  type VideoExportFormat,
  type VideoExportResolution,
} from "@/lib/ffmpeg";
import {
  downloadTranscript,
  type SubtitleFormat,
  type TranscriptDocFormat,
} from "@/lib/serializeTranscript";
import {
  downloadTimelineExport,
  TIMELINE_FORMATS,
  TIMELINE_FRAME_RATES,
  type TimelineExportFormat,
  type TimelineFrameRate,
} from "@/lib/serializeTimeline";
import { AAF_MAX_CLIPS } from "@/lib/aaf/patchAaf";
import { useCutRanges } from "@/hooks/useCutRanges";

type ExportTab = "video" | "audio" | "transcript" | "subtitles" | "timeline";

const VIDEO_FORMATS: { value: VideoExportFormat; label: string }[] = [
  { value: "mp4", label: "MP4" },
  { value: "webm", label: "WebM" },
];

const VIDEO_RESOLUTIONS: { value: VideoExportResolution; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "720", label: "720p" },
  { value: "1080", label: "1080p" },
  { value: "2160", label: "4K" },
];

const AUDIO_FORMATS: { value: AudioExportFormat; label: string }[] = [
  { value: "m4a", label: "M4A" },
  { value: "mp3", label: "MP3" },
  { value: "wav", label: "WAV" },
];

const TRANSCRIPT_FORMATS: { value: TranscriptDocFormat; label: string }[] = [
  { value: "txt", label: "Plain text" },
  { value: "md", label: "Markdown" },
];

const SUBTITLE_FORMATS: { value: SubtitleFormat; label: string }[] = [
  { value: "srt", label: "SRT" },
  { value: "vtt", label: "VTT" },
  { value: "json", label: "JSON" },
];

export default function ExportDialog() {
  const open = useEditorStore((s) => s.exportOpen);
  const setOpen = useEditorStore((s) => s.setExportOpen);
  const videoFile = useEditorStore((s) => s.videoFile);
  const mediaKind = useEditorStore((s) => s.mediaKind);
  const duration = useEditorStore((s) => s.duration);
  const words = useEditorStore((s) => s.words);
  const speakers = useEditorStore((s) => s.speakers);
  const hasAudioTrack = useEditorStore((s) => s.audio !== null);
  const status = useEditorStore((s) => s.status);
  const setStatus = useEditorStore((s) => s.setStatus);
  const exportUrl = useEditorStore((s) => s.exportUrl);
  const setExportUrl = useEditorStore((s) => s.setExportUrl);

  const isAudioProject = mediaKind === "audio";
  const [tab, setTab] = useState<ExportTab>("video");
  const [videoFormat, setVideoFormat] = useState<VideoExportFormat>("mp4");
  const [resolution, setResolution] = useState<VideoExportResolution>("original");
  const [audioFormat, setAudioFormat] = useState<AudioExportFormat>("m4a");
  const [transcriptFormat, setTranscriptFormat] =
    useState<TranscriptDocFormat>("txt");
  const [subtitleFormat, setSubtitleFormat] = useState<SubtitleFormat>("srt");
  const [timelineFormat, setTimelineFormat] =
    useState<TimelineExportFormat>("resolve");
  const [timelineFrameRate, setTimelineFrameRate] =
    useState<TimelineFrameRate>("30");
  const [timelineBusy, setTimelineBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const cuts = useCutRanges();
  const editedDuration = useMemo(
    () => getEditedDuration(cuts, duration),
    [cuts, duration]
  );
  const keepRangeCount = useMemo(
    () => getKeepRanges(cuts, duration).length,
    [cuts, duration]
  );
  const aafOverCap =
    timelineFormat === "aaf" && keepRangeCount > AAF_MAX_CLIPS;
  const exporting = status === "exporting";
  const hasWords = words.length > 0;

  // Fall back when the remembered tab isn't valid for this project.
  const activeTab: ExportTab =
    tab === "video" && isAudioProject
      ? "audio"
      : tab === "audio" && !hasAudioTrack
        ? isAudioProject
          ? "timeline"
          : "video"
        : (tab === "transcript" || tab === "subtitles") && !hasWords
          ? isAudioProject
            ? hasAudioTrack
              ? "audio"
              : "timeline"
            : "video"
          : tab;

  const baseName = videoFile
    ? videoFile.name.replace(/\.[^.]+$/, "")
    : "edited";

  const mediaExt =
    activeTab === "audio"
      ? audioFormat
      : videoFormat === "webm"
        ? "webm"
        : "mp4";
  const mediaFileName = `${baseName}.edited.${mediaExt}`;

  const clearMediaExport = useCallback(() => {
    const prev = useEditorStore.getState().exportUrl;
    if (prev) URL.revokeObjectURL(prev);
    setExportUrl(null);
    setProgress(0);
  }, [setExportUrl]);

  const selectTab = useCallback(
    (next: ExportTab) => {
      setTab((prev) => {
        if (prev === next) return prev;
        clearMediaExport();
        setError(null);
        return next;
      });
    },
    [clearMediaExport]
  );

  const setVideoFormatOption = useCallback(
    (value: VideoExportFormat) => {
      setVideoFormat((prev) => {
        if (prev === value) return prev;
        clearMediaExport();
        return value;
      });
    },
    [clearMediaExport]
  );

  const setResolutionOption = useCallback(
    (value: VideoExportResolution) => {
      setResolution((prev) => {
        if (prev === value) return prev;
        clearMediaExport();
        return value;
      });
    },
    [clearMediaExport]
  );

  const setAudioFormatOption = useCallback(
    (value: AudioExportFormat) => {
      setAudioFormat((prev) => {
        if (prev === value) return prev;
        clearMediaExport();
        return value;
      });
    },
    [clearMediaExport]
  );

  const startMediaExport = useCallback(async () => {
    if (!videoFile) return;
    if (activeTab === "video" && isAudioProject) return;
    if (activeTab === "audio" && !hasAudioTrack) return;

    setError(null);
    setProgress(0);
    setStatus("exporting");
    try {
      const keeps = getKeepRanges(cuts, duration);
      const blob =
        activeTab === "audio"
          ? await exportAudio(videoFile, keeps, editedDuration, setProgress, {
              format: audioFormat,
            })
          : await exportVideo(videoFile, keeps, editedDuration, setProgress, {
              withAudio: hasAudioTrack,
              format: videoFormat,
              resolution,
            });
      const prev = useEditorStore.getState().exportUrl;
      if (prev) URL.revokeObjectURL(prev);
      setExportUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setStatus("ready");
    }
  }, [
    videoFile,
    activeTab,
    isAudioProject,
    hasAudioTrack,
    cuts,
    duration,
    editedDuration,
    audioFormat,
    videoFormat,
    resolution,
    setStatus,
    setExportUrl,
  ]);

  const exportText = useCallback(
    (kind: "transcript" | "subtitles") => {
      if (!hasWords) return;
      const format = kind === "transcript" ? transcriptFormat : subtitleFormat;
      try {
        downloadTranscript(words, format, baseName, {
          duration,
          cuts,
          speakers,
        });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Export failed.");
      }
    },
    [
      hasWords,
      words,
      speakers,
      transcriptFormat,
      subtitleFormat,
      baseName,
      duration,
      cuts,
    ]
  );

  const exportTimeline = useCallback(async () => {
    if (!videoFile) return;
    setTimelineBusy(true);
    setError(null);
    try {
      const keeps = getKeepRanges(cuts, duration);
      const videoEl = useEditorStore.getState().videoEl;
      const width =
        videoEl && "videoWidth" in videoEl
          ? (videoEl as HTMLVideoElement).videoWidth || 1920
          : 1920;
      const height =
        videoEl && "videoHeight" in videoEl
          ? (videoEl as HTMLVideoElement).videoHeight || 1080
          : 1080;
      await downloadTimelineExport(timelineFormat, {
        keepRanges: keeps,
        duration,
        mediaFileName: videoFile.name,
        projectName: baseName,
        frameRate: timelineFrameRate,
        withVideo: !isAudioProject,
        withAudio: hasAudioTrack,
        width,
        height,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Timeline export failed.");
    } finally {
      setTimelineBusy(false);
    }
  }, [
    videoFile,
    cuts,
    duration,
    timelineFormat,
    timelineFrameRate,
    baseName,
    isAudioProject,
    hasAudioTrack,
  ]);

  if (!open) return null;

  const tabs: {
    id: ExportTab;
    label: string;
    icon: typeof Film;
    disabled?: boolean;
    title?: string;
  }[] = [
    {
      id: "video",
      label: "Video",
      icon: Film,
      disabled: isAudioProject,
      title: isAudioProject
        ? "Video export isn’t available for audio-only projects"
        : undefined,
    },
    {
      id: "audio",
      label: "Audio",
      icon: Music,
      disabled: !hasAudioTrack,
      title: !hasAudioTrack ? "This file has no audio track" : undefined,
    },
    {
      id: "transcript",
      label: "Transcript",
      icon: FileText,
      disabled: !hasWords,
      title: !hasWords ? "Transcribe or import a transcript first" : undefined,
    },
    {
      id: "subtitles",
      label: "Subtitles",
      icon: Captions,
      disabled: !hasWords,
      title: !hasWords ? "Transcribe or import a transcript first" : undefined,
    },
    {
      id: "timeline",
      label: "Timeline",
      icon: Clapperboard,
      title: "Export an NLE sequence (Resolve, Premiere, Final Cut, Pro Tools)",
    },
  ];

  // app-no-drag: the backdrop covers the draggable top bar, so it needs to take
  // clicks (dismiss) rather than letting them move the window.
  return (
    <div
      className="app-no-drag fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm dark:bg-black/60"
      onClick={() => !exporting && setOpen(false)}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900 dark:shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Export
          </h2>
          <button
            onClick={() => setOpen(false)}
            disabled={exporting}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X size={16} />
          </button>
        </div>

        <div
          className="mb-5 grid grid-cols-5 gap-0.5 rounded-xl bg-zinc-100 p-0.5 dark:bg-zinc-800"
          role="tablist"
          aria-label="Export type"
        >
          {tabs.map(({ id, label, icon: Icon, disabled, title }) => {
            const selected = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={selected}
                disabled={disabled || exporting}
                title={title}
                onClick={() => selectTab(id)}
                className={`flex h-9 items-center justify-center gap-1.5 rounded-[0.625rem] text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  selected
                    ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                <Icon size={13} className="shrink-0 opacity-70" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            );
          })}
        </div>

        {(activeTab === "video" ||
          activeTab === "audio" ||
          activeTab === "timeline") && (
          <div className="mb-5 grid grid-cols-3 gap-2 text-center">
            <Stat label="Original" value={formatTime(duration)} />
            <Stat label="Cuts" value={String(cuts.length)} />
            <Stat label="Edited" value={formatTime(editedDuration)} accent />
          </div>
        )}

        {activeTab === "video" && (
          <div className="mb-5 space-y-4">
            <OptionGroup
              label="Format"
              value={videoFormat}
              options={VIDEO_FORMATS}
              disabled={exporting}
              onChange={setVideoFormatOption}
            />
            <OptionGroup
              label="Resolution"
              value={resolution}
              options={VIDEO_RESOLUTIONS}
              disabled={exporting}
              onChange={setResolutionOption}
            />
          </div>
        )}

        {activeTab === "audio" && (
          <div className="mb-5">
            <OptionGroup
              label="Format"
              value={audioFormat}
              options={AUDIO_FORMATS}
              disabled={exporting}
              onChange={setAudioFormatOption}
            />
          </div>
        )}

        {activeTab === "transcript" && (
          <div className="mb-5 space-y-3">
            <OptionGroup
              label="Format"
              value={transcriptFormat}
              options={TRANSCRIPT_FORMATS}
              onChange={setTranscriptFormat}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Speaker-labeled text with cuts removed. No timestamps.
            </p>
          </div>
        )}

        {activeTab === "subtitles" && (
          <div className="mb-5 space-y-3">
            <OptionGroup
              label="Format"
              value={subtitleFormat}
              options={SUBTITLE_FORMATS}
              onChange={setSubtitleFormat}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              SRT and VTT use the edited timeline (cuts applied). JSON keeps the
              full word list for re-import.
            </p>
          </div>
        )}

        {activeTab === "timeline" && (
          <div className="mb-5 space-y-4">
            <OptionGroup
              label="NLE"
              value={timelineFormat}
              options={TIMELINE_FORMATS.map(({ value, label }) => ({
                value,
                label,
              }))}
              disabled={timelineBusy}
              onChange={setTimelineFormat}
            />
            <div>
              <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
                Frame rate
              </p>
              <div
                className="grid grid-cols-4 gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800"
                role="radiogroup"
                aria-label="Frame rate"
              >
                {TIMELINE_FRAME_RATES.map((opt) => {
                  const selected = timelineFrameRate === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={timelineBusy}
                      onClick={() => setTimelineFrameRate(opt.value)}
                      className={`flex h-8 items-center justify-center rounded-md px-1 text-[11px] font-medium tabular-nums transition disabled:opacity-40 ${
                        selected
                          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
                          : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Sequence references your original media by filename — relink in
              the NLE after import.{" "}
              {timelineFormat === "aaf"
                ? "Pro Tools / Logic AAF (metadata-only)."
                : timelineFormat === "fcpx"
                  ? "Final Cut Pro FCPXML."
                  : timelineFormat === "premiere"
                    ? "Adobe Premiere Pro XML (xmeml)."
                    : "DaVinci Resolve XML (xmeml)."}
            </p>
            {aafOverCap && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                This edit has {keepRangeCount} clips; AAF supports up to{" "}
                {AAF_MAX_CLIPS}. Use Resolve, Premiere, or Final Cut instead.
              </p>
            )}
          </div>
        )}

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">
            {error}
          </p>
        )}

        {(activeTab === "video" || activeTab === "audio") &&
          (exporting ? (
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="font-medium text-zinc-700 dark:text-zinc-200">
                  Rendering in your browser…
                </span>
                <span className="tabular-nums text-zinc-400 dark:text-zinc-500">
                  {Math.round(progress * 100)}%
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div
                  className="h-full rounded-full bg-neutral-500 transition-[width] duration-300 dark:bg-neutral-400"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">
                Re-encoding with ffmpeg.wasm — longer files take a while.
              </p>
            </div>
          ) : exportUrl ? (
            <div className="flex flex-col gap-2">
              <a
                href={exportUrl}
                download={mediaFileName}
                className="flex h-10 items-center justify-center gap-2 rounded-xl bg-neutral-600 px-4 text-sm font-medium text-white transition hover:bg-neutral-500 dark:bg-neutral-500 dark:hover:bg-neutral-400"
              >
                <Download size={15} className="shrink-0" />
                <span className="truncate">Download {mediaFileName}</span>
              </a>
              <button
                onClick={startMediaExport}
                className="h-10 rounded-xl text-sm font-medium text-zinc-500 transition hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Re-export with latest edits
              </button>
            </div>
          ) : (
            <button
              onClick={startMediaExport}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              <Download size={15} />
              Export{" "}
              {activeTab === "audio"
                ? audioFormat.toUpperCase()
                : videoFormat.toUpperCase()}
            </button>
          ))}

        {activeTab === "transcript" && (
          <button
            onClick={() => exportText("transcript")}
            disabled={!hasWords}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Download size={15} />
            Download .{transcriptFormat}
          </button>
        )}

        {activeTab === "subtitles" && (
          <button
            onClick={() => exportText("subtitles")}
            disabled={!hasWords}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Download size={15} />
            Download .{subtitleFormat}
          </button>
        )}

        {activeTab === "timeline" && (
          <button
            onClick={exportTimeline}
            disabled={timelineBusy || !videoFile || aafOverCap}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Download size={15} />
            {timelineBusy
              ? "Preparing…"
              : `Download .${TIMELINE_FORMATS.find((f) => f.value === timelineFormat)?.ext}`}
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-3 ${
        accent
          ? "bg-neutral-50 dark:bg-neutral-800/60"
          : "bg-zinc-50 dark:bg-zinc-800/60"
      }`}
    >
      <p
        className={`text-xs ${
          accent
            ? "text-neutral-400 dark:text-neutral-500"
            : "text-zinc-400 dark:text-zinc-500"
        }`}
      >
        {label}
      </p>
      <p
        className={`mt-0.5 text-sm font-semibold tabular-nums ${
          accent
            ? "text-neutral-700 dark:text-neutral-200"
            : "text-zinc-800 dark:text-zinc-100"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function OptionGroup<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <div
        className="grid gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
        role="radiogroup"
        aria-label={label}
      >
        {options.map((opt) => {
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(opt.value)}
              className={`flex h-8 items-center justify-center rounded-md px-1 text-xs font-medium transition disabled:opacity-40 ${
                selected
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
