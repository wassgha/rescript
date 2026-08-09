"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Captions,
  Download,
  FileText,
  Film,
  Music,
  X,
} from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { trackEvent } from "@/lib/telemetry";
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
import { useCutRanges } from "@/hooks/useCutRanges";
import { useI18n } from "./I18nProvider";
import { localizeRuntimeMessage } from "@/lib/i18n";

type ExportTab = "video" | "audio" | "transcript" | "subtitles";

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
  const { t } = useI18n();
  const open = useEditorStore((s) => s.exportOpen);
  const setOpen = useEditorStore((s) => s.setExportOpen);
  const videoFile = useEditorStore((s) => s.videoFile);
  const mediaKind = useEditorStore((s) => s.mediaKind);
  const duration = useEditorStore((s) => s.duration);
  const words = useEditorStore((s) => s.words);
  const speakers = useEditorStore((s) => s.speakers);
  const hasAudioTrack = useEditorStore((s) => s.hasAudio);
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
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const cuts = useCutRanges();
  const editedDuration = useMemo(
    () => getEditedDuration(cuts, duration),
    [cuts, duration]
  );
  const exporting = status === "exporting";
  const hasWords = words.length > 0;

  // Fall back when the remembered tab isn't valid for this project.
  const activeTab: ExportTab =
    tab === "video" && isAudioProject
      ? "audio"
      : tab === "audio" && !hasAudioTrack
        ? isAudioProject
          ? "transcript"
          : "video"
        : (tab === "transcript" || tab === "subtitles") && !hasWords
          ? isAudioProject
            ? "audio"
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
      trackEvent("export_completed", {
        kind: activeTab,
        format: activeTab === "audio" ? audioFormat : videoFormat,
        ...(activeTab === "audio" ? {} : { resolution }),
      });
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
        trackEvent("export_completed", { kind, format });
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
      label: t("export.video"),
      icon: Film,
      disabled: isAudioProject,
      title: isAudioProject
        ? t("export.videoUnavailable")
        : undefined,
    },
    {
      id: "audio",
      label: t("export.audio"),
      icon: Music,
      disabled: !hasAudioTrack,
      title: !hasAudioTrack ? t("export.noAudio") : undefined,
    },
    {
      id: "transcript",
      label: t("export.transcript"),
      icon: FileText,
      disabled: !hasWords,
      title: !hasWords ? t("export.noWordsFirst") : undefined,
    },
    {
      id: "subtitles",
      label: t("export.subtitles"),
      icon: Captions,
      disabled: !hasWords,
      title: !hasWords ? t("export.noWordsFirst") : undefined,
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
            {t("export.title")}
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
          className="mb-5 grid grid-cols-4 gap-0.5 rounded-xl bg-zinc-100 p-0.5 dark:bg-zinc-800"
          role="tablist"
          aria-label={t("export.type")}
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

        {(activeTab === "video" || activeTab === "audio") && (
          <div className="mb-5 grid grid-cols-3 gap-2 text-center">
            <Stat label={t("export.statOriginal")} value={formatTime(duration)} />
            <Stat label={t("export.statCuts")} value={String(cuts.length)} />
            <Stat label={t("export.statEdited")} value={formatTime(editedDuration)} accent />
          </div>
        )}

        {activeTab === "video" && (
          <div className="mb-5 space-y-4">
            <OptionGroup
              label={t("export.format")}
              value={videoFormat}
              options={VIDEO_FORMATS}
              disabled={exporting}
              onChange={setVideoFormatOption}
            />
            <OptionGroup
              label={t("export.resolution")}
              value={resolution}
              options={VIDEO_RESOLUTIONS.map((option) =>
                option.value === "original"
                  ? { ...option, label: t("export.original") }
                  : option
              )}
              disabled={exporting}
              onChange={setResolutionOption}
            />
          </div>
        )}

        {activeTab === "audio" && (
          <div className="mb-5">
            <OptionGroup
              label={t("export.format")}
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
              label={t("export.format")}
              value={transcriptFormat}
              options={TRANSCRIPT_FORMATS.map((option) =>
                option.value === "txt"
                  ? { ...option, label: t("export.plainText") }
                  : option
              )}
              onChange={setTranscriptFormat}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("export.transcriptHelp")}
            </p>
          </div>
        )}

        {activeTab === "subtitles" && (
          <div className="mb-5 space-y-3">
            <OptionGroup
              label={t("export.format")}
              value={subtitleFormat}
              options={SUBTITLE_FORMATS}
              onChange={setSubtitleFormat}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("export.subtitlesHelp")}
            </p>
          </div>
        )}

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900/30 dark:bg-red-950/30 dark:text-red-900">
            {localizeRuntimeMessage(error, t)}
          </p>
        )}

        {(activeTab === "video" || activeTab === "audio") &&
          (exporting ? (
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="font-medium text-zinc-700 dark:text-zinc-200">
                  {t("export.rendering")}
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
                {t("export.encodingHelp")}
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
                <span className="truncate">{t("export.downloadFile", { name: mediaFileName })}</span>
              </a>
              <button
                onClick={startMediaExport}
                className="h-10 rounded-xl text-sm font-medium text-zinc-500 transition hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                {t("export.reexport")}
              </button>
            </div>
          ) : (
            <button
              onClick={startMediaExport}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              <Download size={15} />
              {t("export.exportFormat", {
                format:
                  activeTab === "audio"
                    ? audioFormat.toUpperCase()
                    : videoFormat.toUpperCase(),
              })}
            </button>
          ))}

        {activeTab === "transcript" && (
          <button
            onClick={() => exportText("transcript")}
            disabled={!hasWords}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Download size={15} />
            {t("export.downloadFormat", { format: transcriptFormat })}
          </button>
        )}

        {activeTab === "subtitles" && (
          <button
            onClick={() => exportText("subtitles")}
            disabled={!hasWords}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Download size={15} />
            {t("export.downloadFormat", { format: subtitleFormat })}
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
