"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { AudioLines, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import {
  cutRangeAt,
  formatTime,
  getEditedDuration,
  getEffectiveCuts,
  originalToEdited,
} from "@/lib/edits";

export default function MediaPreview() {
  const mediaUrl = useEditorStore((s) => s.mediaUrl);
  const videoFile = useEditorStore((s) => s.videoFile);
  const mediaKind = useEditorStore((s) => s.mediaKind);
  const words = useEditorStore((s) => s.words);
  const duration = useEditorStore((s) => s.duration);
  const cutAdjustments = useEditorStore((s) => s.cutAdjustments);
  const playing = useEditorStore((s) => s.playing);
  const currentTime = useEditorStore((s) => s.currentTime);
  const setVideoEl = useEditorStore((s) => s.setVideoEl);
  const setDuration = useEditorStore((s) => s.setDuration);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const setCurrentTime = useEditorStore((s) => s.setCurrentTime);

  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const isAudio = mediaKind === "audio";
  const cuts = useMemo(
    () => getEffectiveCuts(words, duration, cutAdjustments),
    [words, duration, cutAdjustments]
  );
  const cutsRef = useRef(cuts);
  useEffect(() => {
    cutsRef.current = cuts;
  }, [cuts]);

  const editedDuration = useMemo(
    () => getEditedDuration(cuts, duration),
    [cuts, duration]
  );

  const refCb = useCallback(
    (el: HTMLMediaElement | null) => {
      mediaRef.current = el;
      setVideoEl(el);
    },
    [setVideoEl]
  );

  // Playback loop: mirror time into the store and skip over cut ranges.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const media = mediaRef.current;
      if (media) {
        let t = media.currentTime;
        if (!media.paused) {
          const cut = cutRangeAt(t, cutsRef.current);
          if (cut) {
            const target = cut.end + 0.001;
            if (target >= media.duration - 0.05) {
              media.pause();
              media.currentTime = cut.start;
              t = cut.start;
            } else {
              media.currentTime = target;
              t = target;
            }
          }
        }
        const prev = useEditorStore.getState().currentTime;
        if (Math.abs(prev - t) > 0.005) setCurrentTime(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setCurrentTime]);

  const togglePlay = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) {
      // If we're parked inside a cut (or at the end), jump to kept content.
      const cut = cutRangeAt(media.currentTime, cutsRef.current);
      if (cut) media.currentTime = cut.end + 0.001;
      if (media.currentTime >= media.duration - 0.05) media.currentTime = 0;
      void media.play();
    } else {
      media.pause();
    }
  }, []);

  const skip = useCallback((delta: number) => {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = Math.min(Math.max(0, media.currentTime + delta), media.duration);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-50/70 p-4">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {mediaUrl && isAudio && (
          <>
            <button
              type="button"
              onClick={togglePlay}
              className="flex w-full max-w-md cursor-pointer flex-col items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-8 py-14 text-center shadow-sm transition hover:border-zinc-300"
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-900 text-white">
                <AudioLines size={24} />
              </div>
              <p className="max-w-full truncate text-sm font-medium text-zinc-800">
                {videoFile?.name ?? "Audio"}
              </p>
              <p className="text-xs text-zinc-400">Audio · click to play</p>
            </button>
            <audio
              ref={refCb}
              src={mediaUrl}
              preload="metadata"
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              className="hidden"
            />
          </>
        )}
        {mediaUrl && !isAudio && (
          <video
            ref={refCb}
            src={mediaUrl}
            playsInline
            onClick={togglePlay}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            className="max-h-full max-w-full cursor-pointer rounded-xl bg-black shadow-lg shadow-zinc-900/10"
          />
        )}
      </div>

      <div className="mt-3 flex shrink-0 items-center justify-center gap-2">
        <span className="mr-2 w-28 text-right text-xs tabular-nums text-zinc-500">
          {formatTime(originalToEdited(currentTime, cuts))}
          <span className="text-zinc-300"> / {formatTime(editedDuration)}</span>
        </span>
        <button
          onClick={() => skip(-5)}
          title="Back 5 s"
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition hover:bg-zinc-200"
        >
          <SkipBack size={15} />
        </button>
        <button
          onClick={togglePlay}
          title="Play / pause (space)"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900 text-white shadow transition hover:bg-zinc-700"
        >
          {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
        </button>
        <button
          onClick={() => skip(5)}
          title="Forward 5 s"
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition hover:bg-zinc-200"
        >
          <SkipForward size={15} />
        </button>
        <span className="ml-2 w-28 text-xs tabular-nums text-zinc-400">
          {editedDuration < duration - 0.01 && <>original {formatTime(duration)}</>}
        </span>
      </div>
    </div>
  );
}
