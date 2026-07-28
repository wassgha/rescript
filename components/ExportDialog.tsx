"use client";

import { useCallback, useMemo, useState } from "react";
import { Download, X } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { formatTime, getEditedDuration, getEffectiveCuts, getKeepRanges } from "@/lib/edits";
import { exportAudio, exportVideo } from "@/lib/ffmpeg";

export default function ExportDialog() {
  const open = useEditorStore((s) => s.exportOpen);
  const setOpen = useEditorStore((s) => s.setExportOpen);
  const videoFile = useEditorStore((s) => s.videoFile);
  const mediaKind = useEditorStore((s) => s.mediaKind);
  const words = useEditorStore((s) => s.words);
  const duration = useEditorStore((s) => s.duration);
  const cutAdjustments = useEditorStore((s) => s.cutAdjustments);
  const status = useEditorStore((s) => s.status);
  const setStatus = useEditorStore((s) => s.setStatus);
  const exportUrl = useEditorStore((s) => s.exportUrl);
  const setExportUrl = useEditorStore((s) => s.setExportUrl);

  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const cuts = useMemo(
    () => getEffectiveCuts(words, duration, cutAdjustments),
    [words, duration, cutAdjustments]
  );
  const editedDuration = useMemo(() => getEditedDuration(cuts, duration), [cuts, duration]);
  const exporting = status === "exporting";
  const isAudio = mediaKind === "audio";
  const ext = isAudio ? "m4a" : "mp4";
  const formatLabel = isAudio ? "M4A" : "MP4";

  const fileName = videoFile
    ? videoFile.name.replace(/\.[^.]+$/, "") + `.edited.${ext}`
    : `edited.${ext}`;

  const start = useCallback(async () => {
    if (!videoFile) return;
    setError(null);
    setProgress(0);
    setStatus("exporting");
    try {
      const keeps = getKeepRanges(cuts, duration);
      const blob = isAudio
        ? await exportAudio(videoFile, keeps, editedDuration, setProgress)
        : await exportVideo(videoFile, keeps, editedDuration, setProgress);
      const prev = useEditorStore.getState().exportUrl;
      if (prev) URL.revokeObjectURL(prev);
      setExportUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setStatus("ready");
    }
  }, [videoFile, isAudio, cuts, duration, editedDuration, setStatus, setExportUrl]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm"
      onClick={() => !exporting && setOpen(false)}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900">
            Export {isAudio ? "audio" : "video"}
          </h2>
          <button
            onClick={() => setOpen(false)}
            disabled={exporting}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mb-5 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-zinc-50 p-3">
            <p className="text-xs text-zinc-400">Original</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-800">
              {formatTime(duration)}
            </p>
          </div>
          <div className="rounded-xl bg-zinc-50 p-3">
            <p className="text-xs text-zinc-400">Cuts</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-800">
              {cuts.length}
            </p>
          </div>
          <div className="rounded-xl bg-neutral-50 p-3">
            <p className="text-xs text-neutral-400">Edited</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums text-neutral-700">
              {formatTime(editedDuration)}
            </p>
          </div>
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
        )}

        {exporting ? (
          <div>
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium text-zinc-700">Rendering in your browser…</span>
              <span className="tabular-nums text-zinc-400">{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-100">
              <div
                className="h-full rounded-full bg-neutral-500 transition-[width] duration-300"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <p className="mt-3 text-xs text-zinc-400">
              Re-encoding with ffmpeg.wasm — longer files take a while.
            </p>
          </div>
        ) : exportUrl ? (
          <div className="flex flex-col gap-2">
            <a
              href={exportUrl}
              download={fileName}
              className="flex h-10 items-center justify-center gap-2 rounded-xl bg-neutral-600 text-sm font-medium text-white transition hover:bg-neutral-500"
            >
              <Download size={15} />
              Download {fileName}
            </a>
            <button
              onClick={start}
              className="h-10 rounded-xl text-sm font-medium text-zinc-500 transition hover:bg-zinc-50"
            >
              Re-export with latest edits
            </button>
          </div>
        ) : (
          <button
            onClick={start}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-medium text-white transition hover:bg-zinc-700"
          >
            <Download size={15} />
            Export {formatLabel}
          </button>
        )}
      </div>
    </div>
  );
}
