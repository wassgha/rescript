"use client";

import { useCallback, useEffect, useRef } from "react";
import { liveSequence, useEditorStore } from "@/lib/store";
import { PLAYHEAD_EPSILON_S } from "@/lib/edits";
import { playheadPiece, type Sequence } from "@/lib/sequence";

/**
 * Owns the <video>/<audio> element and the playback loop that plays the edit's
 * pieces in order — skipping cuts, and jumping back for reordered or
 * duplicated media.
 * In video mode this is the visual preview; in audio mode it mounts a hidden
 * <audio> so playback still works when the preview panel is omitted.
 */
export default function MediaPreview() {
  const mediaUrl = useEditorStore((s) => s.mediaUrl);
  const mediaKind = useEditorStore((s) => s.mediaKind);
  const setVideoEl = useEditorStore((s) => s.setVideoEl);
  const setDuration = useEditorStore((s) => s.setDuration);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const setCurrentTime = useEditorStore((s) => s.setCurrentTime);

  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const isAudio = mediaKind === "audio";

  const refCb = useCallback(
    (el: HTMLMediaElement | null) => {
      mediaRef.current = el;
      setVideoEl(el);
    },
    [setVideoEl]
  );

  // Playback loop: mirror time into the store and move on to the next piece
  // whenever the playhead leaves the one it is in.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const media = mediaRef.current;
      if (media) {
        let t = media.currentTime;
        const s = useEditorStore.getState();
        let copy = s.currentCopy;
        let piece = s.currentPiece;
        if (!media.paused) {
          const next = advance(media, t, copy, piece, liveSequence());
          t = next.time;
          copy = next.copy;
          piece = next.piece;
        }
        if (
          Math.abs(s.currentTime - t) > 0.005 ||
          s.currentCopy !== copy ||
          s.currentPiece !== piece
        ) {
          setCurrentTime(t, copy, piece);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setCurrentTime]);

  // The file can run out in the middle of the edit (its end was moved before
  // other pieces): carry on with whatever plays next.
  const onEnded = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    const s = useEditorStore.getState();
    const next = advance(media, media.duration, s.currentCopy, s.currentPiece, liveSequence());
    setCurrentTime(next.time, next.copy, next.piece);
    if (next.resume) void media.play();
  }, [setCurrentTime]);

  const togglePlay = useCallback(() => {
    useEditorStore.getState().togglePlayback();
  }, []);

  if (!mediaUrl) return null;

  if (isAudio) {
    return (
      <audio
        ref={refCb}
        src={mediaUrl}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={onEnded}
        className="hidden"
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-50/70 p-3 sm:p-4 dark:bg-zinc-950/70">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <video
          ref={refCb}
          src={mediaUrl}
          playsInline
          onClick={togglePlay}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={onEnded}
          className="max-h-full max-w-full cursor-pointer rounded-sm bg-black shadow-lg shadow-zinc-900/10 dark:shadow-black/40"
        />
      </div>
    </div>
  );
}

/**
 * Where playback goes from source time `t` of `copy`, given the piece it was
 * last in (`hint`): stay inside the current piece; once past its end, or from
 * inside a cut, seek to the start of the piece that plays next (forward over a
 * cut or back for a reorder). Past the last piece it pauses, parked at the end.
 * `resume` says whether the element must be told to play again (it had ended).
 */
function advance(
  media: HTMLMediaElement,
  t: number,
  copy: number,
  hint: number | null,
  seq: Sequence
): { time: number; copy: number; piece: number | null; resume: boolean } {
  let i = playheadPiece(seq, copy, t, hint);
  if (i >= 0 && t >= seq.pieces[i].end - 1e-6) i += 1;
  const piece = i >= 0 ? seq.pieces[i] : undefined;
  if (!piece) {
    const last = seq.pieces.length - 1;
    media.pause();
    if (last < 0) return { time: t, copy, piece: null, resume: false };
    const end = seq.pieces[last];
    media.currentTime = end.end;
    return { time: end.end, copy: end.copy, piece: last, resume: false };
  }
  if (piece.copy === copy && t >= piece.start - 1e-4 && t < piece.end) {
    return { time: t, copy, piece: i, resume: false };
  }
  const target = piece.start + PLAYHEAD_EPSILON_S;
  media.currentTime = target;
  return { time: target, copy: piece.copy, piece: i, resume: media.ended || media.paused };
}
