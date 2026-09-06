"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Clapperboard,
  Download,
  FileText,
  Film,
  Music,
  X,
} from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { reportError } from "@/lib/sentry";
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
  type TranscriptFormat,
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
import { useI18n } from "./I18nProvider";
import { localizeRuntimeMessage } from "@/lib/i18n";
import { en } from "@/lib/i18n/messages/en";

type ExportTab = "video" | "audio" | "transcript" | "timeline";

/** Document formats that support an optional timestamps toggle. */
const DOC_FORMATS = new Set<TranscriptFormat>(["txt", "md", "docx", "pdf"]);

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

/** Transcript + subtitle formats in one list (timestamps optional on docs). */
const TEXT_FORMATS: { value: TranscriptFormat; label: string }[] = [
  { value: "txt", label: "TXT" },
  { value: "md", label: "MD" },
  { value: "docx", label: "DOCX" },
  { value: "pdf", label: "PDF" },
  { value: "srt", label: "SRT" },
  { value: "vtt", label: "VTT" },
  { value: "json", label: "JSON" },
];

const TIMELINE_HELP_KEY: Record<
  TimelineExportFormat,
  | "export.timelineHelpResolve"
  | "export.timelineHelpPremiere"
  | "export.timelineHelpFcpx"
  | "export.timelineHelpAaf"
  | "export.timelineHelpReaper"
  | "export.timelineHelpSamplitude"
> = {
  resolve: "export.timelineHelpResolve",
  premiere: "export.timelineHelpPremiere",
  fcpx: "export.timelineHelpFcpx",
  aaf: "export.timelineHelpAaf",
  reaper: "export.timelineHelpReaper",
  samplitude: "export.timelineHelpSamplitude",
};

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
  const [textFormat, setTextFormat] = useState<TranscriptFormat>("txt");
  const [includeTimestamps, setIncludeTimestamps] = useState(false);
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
  const timelineMeta = TIMELINE_FORMATS.find((f) => f.value === timelineFormat);
  const showTimelineFrameRate = timelineMeta?.needsFrameRate ?? true;
  const exporting = status === "exporting";
  const dialogBusy = exporting || timelineBusy;
  const hasWords = words.length > 0;

  // Fall back when the remembered tab isn't valid for this project.
  const activeTab: ExportTab =
    tab === "video" && isAudioProject
      ? "audio"
      : tab === "audio" && !hasAudioTrack
        ? isAudioProject
          ? "timeline"
          : "video"
        : tab === "transcript" && !hasWords
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
      trackEvent("export_completed", {
        kind: activeTab,
        format: activeTab === "audio" ? audioFormat : videoFormat,
        ...(activeTab === "audio" ? {} : { resolution }),
      });
    } catch (err) {
      // The message we show is friendly and lossy — "Export failed while
      // rendering the video" says nothing about which of ffmpeg's failure modes
      // it was. Send the original so the export path is visible in Sentry at
      // all; until now only the crashes that escaped this catch were.
      reportError(err, `export-${activeTab}`);
      setError(err instanceof Error ? err.message : en["error.export"]);
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

  const textSupportsTimestamps = DOC_FORMATS.has(textFormat);

  const exportText = useCallback(() => {
    if (!hasWords) return;
    try {
      downloadTranscript(words, textFormat, baseName, {
        duration,
        cuts,
        speakers,
        ...(textSupportsTimestamps ? { timestamps: includeTimestamps } : {}),
      });
      setError(null);
      trackEvent("export_completed", {
        kind: "transcript",
        format: textFormat,
        ...(textSupportsTimestamps ? { timestamps: includeTimestamps } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : en["error.export"]);
    }
  }, [
    hasWords,
    words,
    speakers,
    textFormat,
    textSupportsTimestamps,
    includeTimestamps,
    baseName,
    duration,
    cuts,
  ]);

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
      trackEvent("export_completed", { kind: "timeline", format: timelineFormat });
    } catch (err) {
      setError(err instanceof Error ? err.message : en["error.timelineExport"]);
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
      id: "timeline",
      label: t("export.timeline"),
      icon: Clapperboard,
      title: t("export.timelineTitle"),
    },
  ];

  // app-no-drag: the backdrop covers the draggable top bar, so it needs to take
  // clicks (dismiss) rather than letting them move the window.
  return (
    <div
      className="app-no-drag fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm dark:bg-black/60"
      onClick={() => !dialogBusy && setOpen(false)}
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
            disabled={dialogBusy}
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
                disabled={disabled || dialogBusy}
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
              value={textFormat}
              options={TEXT_FORMATS.map((option) =>
                option.value === "txt"
                  ? { ...option, label: t("export.plainText") }
                  : option.value === "md"
                    ? { ...option, label: t("export.markdown") }
                    : option
              )}
              columns={4}
              onChange={setTextFormat}
            />
            {textSupportsTimestamps && (
              <label className="flex cursor-pointer items-center gap-2.5 rounded-lg bg-zinc-50 px-3 py-2.5 text-sm text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200">
                <input
                  type="checkbox"
                  checked={includeTimestamps}
                  onChange={(e) => setIncludeTimestamps(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400 dark:border-zinc-600 dark:bg-zinc-900"
                />
                <span>{t("export.includeTimestamps")}</span>
              </label>
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {textFormat === "srt" || textFormat === "vtt" || textFormat === "json"
                ? t("export.subtitlesHelp")
                : includeTimestamps
                  ? t("export.transcriptHelpTimestamps")
                  : t("export.transcriptHelp")}
              {textFormat === "pdf" ? ` ${t("export.transcriptHelpPdf")}` : ""}
            </p>
          </div>
        )}

        {activeTab === "timeline" && (
          <div className="mb-5 space-y-4">
            <div>
              <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
                {t("export.nle")}
              </p>
              <select
                value={timelineFormat}
                disabled={timelineBusy}
                onChange={(e) =>
                  setTimelineFormat(e.target.value as TimelineExportFormat)
                }
                aria-label={t("export.nle")}
                className="h-10 w-full appearance-none rounded-lg border border-zinc-200 bg-white bg-[length:12px] bg-[right_0.75rem_center] bg-no-repeat px-3 pr-9 text-sm text-zinc-900 outline-none transition focus:border-zinc-400 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50 dark:focus:border-zinc-500"
                style={{
                  backgroundImage:
                    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")",
                }}
              >
                {TIMELINE_FORMATS.map(({ value, label, ext }) => (
                  <option key={value} value={value}>
                    {label} (.{ext})
                  </option>
                ))}
              </select>
            </div>
            {showTimelineFrameRate && (
              <div>
                <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
                  {t("export.frameRate")}
                </p>
                <div
                  className="grid grid-cols-4 gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800"
                  role="radiogroup"
                  aria-label={t("export.frameRate")}
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
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("export.timelineHelp")} {t(TIMELINE_HELP_KEY[timelineFormat])}
            </p>
            {aafOverCap && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                {t("export.aafOverCap", {
                  count: keepRangeCount,
                  max: AAF_MAX_CLIPS,
                })}
              </p>
            )}
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
            onClick={exportText}
            disabled={!hasWords}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Download size={15} />
            {t("export.downloadFormat", { format: textFormat })}
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
              ? t("export.preparing")
              : t("export.downloadFormat", {
                  format: timelineMeta?.ext ?? "xml",
                })}
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
  columns,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  /** Cap columns so longer lists wrap instead of crushing labels. */
  columns?: number;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const cols = Math.min(columns ?? options.length, options.length);
  return (
    <div>
      <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <div
        className="grid gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
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
              className={`flex min-h-8 flex-col items-center justify-center rounded-md px-1 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
                selected
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              <span className="leading-tight">{opt.label}</span>
              {opt.hint && (
                <span
                  className={`text-[10px] font-normal leading-tight ${
                    selected
                      ? "text-zinc-400 dark:text-zinc-300"
                      : "text-zinc-400 dark:text-zinc-500"
                  }`}
                >
                  {opt.hint}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
