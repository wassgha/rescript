"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Merge,
  Pause,
  Play,
  RotateCcw,
  SquareSplitHorizontal,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEditorStore } from "@/lib/store";
import {
  canSplitAt,
  cutRangeAt,
  formatTime,
  getActiveSceneBoundaries,
  getClipSegments,
  getEditedDuration,
  getKeepRanges,
  isWordCutOut,
  originalToEdited,
  trimEdgeBounds,
} from "@/lib/edits";
import type { ClipSegment, Word } from "@/lib/types";
import { isDisfluencyPlaceholder } from "@/lib/disfluencies";
import { VAD_SAMPLE_RATE } from "@/lib/vad";
import { peakBetween } from "@/lib/waveform";
import { useCutRanges } from "@/hooks/useCutRanges";
import { useIsDark } from "@/hooks/useIsDark";
import { useI18n } from "./I18nProvider";

const RULER_H = 18;
const WORDBAR_H = 28;
/** Share of the waveform lane a full-scale (±1) signal fills, leaving a margin. */
const WAVE_LANE_FILL = 0.9;
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
/** Pixels-per-second below which the timeline is considered "small". */
const SMALL_PPS = 22;
/** Pixels-per-second above which edge handles appear on words. */
const HANDLE_VIS_PPS = 40;
const MIN_ZOOM = 1;
const MAX_ZOOM = 256;
/** Wheel-zoom sensitivity (higher = faster zoom per scroll tick). */
const ZOOM_SPEED = 0.0028;
/** How close (px) the pointer must be to a split marker to reveal its join button. */
const SPLIT_HOVER_PX = 10;
/** Inset + radius for selected clip/cut outlines (`rounded-sm` ≈ 2px). */
const SELECTION_INSET = 2;
const SELECTION_RADIUS = 2;

/** Canvas path for a rounded rect (used to keep cut fills inside the selection ring). */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (radius <= 0 || w <= 0 || h <= 0) {
    ctx.rect(x, y, Math.max(0, w), Math.max(0, h));
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

type DragKind =
  | { type: "seek" }
  | { type: "word"; wordId: number; edge: "start" | "end"; origStart: number; origEnd: number }
  /**
   * `time` tracks where the dragged edge currently sits (mutated as the drag
   * moves); `lo`/`hi` bound it to this clip and the gap next to it, so an edge
   * can close a gap completely but never cross the neighbouring clip's handle.
   */
  | { type: "trim"; edge: "in" | "out"; time: number; lo: number; hi: number };

export default function Timeline() {
  const { t } = useI18n();
  const waveform = useEditorStore((s) => s.waveform);
  const words = useEditorStore((s) => s.words);
  const sceneBoundaries = useEditorStore((s) => s.sceneBoundaries);
  const duration = useEditorStore((s) => s.duration);
  const currentTime = useEditorStore((s) => s.currentTime);
  const playing = useEditorStore((s) => s.playing);
  const selectedClipIndex = useEditorStore((s) => s.selectedClipIndex);
  const selectedCutIndex = useEditorStore((s) => s.selectedCutIndex);
  const selectedWordIds = useEditorStore((s) => s.selectedWordIds);
  const status = useEditorStore((s) => s.status);

  const cuts = useCutRanges();
  const keeps = useMemo(() => getKeepRanges(cuts, duration), [cuts, duration]);
  const clips = useMemo(
    () => getClipSegments(keeps, sceneBoundaries),
    [keeps, sceneBoundaries]
  );
  const splitOk = useMemo(
    () => canSplitAt(currentTime, duration, cuts, sceneBoundaries),
    [currentTime, duration, cuts, sceneBoundaries]
  );
  /** Splits that divide two touching clips — the joinable ones. */
  const splits = useMemo(
    () => getActiveSceneBoundaries(sceneBoundaries, keeps),
    [sceneBoundaries, keeps]
  );

  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragKind | null>(null);
  const [dragging, setDragging] = useState(false);

  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [hoveredWordId, setHoveredWordId] = useState<number | null>(null);
  const [hoveredClipIndex, setHoveredClipIndex] = useState<number | null>(null);
  const [hoveredCutIndex, setHoveredCutIndex] = useState<number | null>(null);
  /** Id of the split marker under the pointer, if any. */
  const [hoveredSplitId, setHoveredSplitId] = useState<number | null>(null);
  const dark = useIsDark();

  const fitPps = duration > 0 && width > 0 ? width / duration : 50;
  const pps = fitPps * zoom;
  const totalWidth = Math.max(width, duration * pps);
  const ready = status === "ready" && duration > 0;
  // Clip delete is for a clip-body click (no word selection). Clicking a word
  // also selects its clip for trim handles — don't treat that as "delete clip".
  const deleteOk =
    selectedClipIndex != null &&
    selectedWordIds.length === 0 &&
    clips.some((c) => c.index === selectedClipIndex);
  const selectedWordsAllCutOut = useMemo(() => {
    if (selectedWordIds.length === 0) return false;
    const idSet = new Set(selectedWordIds);
    let count = 0;
    for (const w of words) {
      if (!idSet.has(w.id)) continue;
      count++;
      if (!isWordCutOut(w, cuts)) return false;
    }
    return count > 0;
  }, [selectedWordIds, words, cuts]);
  const restoreOk =
    (selectedCutIndex != null && cuts[selectedCutIndex] != null) ||
    selectedWordsAllCutOut;

  // Live mirrors for imperative wheel/drag handlers (avoid stale closures).
  const ppsRef = useRef(pps);
  const zoomRef = useRef(zoom);
  const widthRef = useRef(width);
  const durationRef = useRef(duration);
  useEffect(() => {
    ppsRef.current = pps;
    zoomRef.current = zoom;
    widthRef.current = width;
    durationRef.current = duration;
  });

  // Scroll position to apply after a wheel-zoom re-renders the track width.
  const pendingScrollRef = useRef<number | null>(null);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setHeight(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Draw ruler + waveform + cut overlay + clip tint for the visible window.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const trackTop = RULER_H + WORDBAR_H;
    const trackH = height - trackTop;
    const midY = trackTop + trackH / 2;

    // Soft track wash
    ctx.fillStyle = dark ? "#09090b" : "#fafafa";
    ctx.fillRect(0, trackTop, width, trackH);

    // Ruler
    ctx.fillStyle = dark ? "#71717a" : "#a1a1aa";
    ctx.font = "9px ui-sans-serif, system-ui";
    ctx.textBaseline = "top";
    const step = TICK_STEPS.find((s) => s * pps >= 70) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const firstTick = Math.floor(scrollLeft / pps / step) * step;
    for (let t = firstTick; t <= (scrollLeft + width) / pps + step; t += step) {
      const x = t * pps - scrollLeft;
      ctx.fillStyle = dark ? "#3f3f46" : "#e4e4e7";
      ctx.fillRect(x, RULER_H - 6, 1, 6);
      ctx.fillStyle = dark ? "#71717a" : "#a1a1aa";
      ctx.fillText(formatTime(t), x + 4, 3);
    }
    ctx.strokeStyle = dark ? "#27272a" : "#f0f0f2";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(width, RULER_H - 0.5);
    ctx.stroke();

    // Wordbar lane background
    ctx.fillStyle = dark ? "#27272a" : "#f4f4f5";
    ctx.fillRect(0, RULER_H, width, WORDBAR_H);
    ctx.strokeStyle = dark ? "#3f3f46" : "#ececef";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + WORDBAR_H - 0.5);
    ctx.lineTo(width, RULER_H + WORDBAR_H - 0.5);
    ctx.stroke();

    if (duration === 0) return;

    // Clip selection / hover washes on waveform
    for (const clip of clips) {
      const x0 = clip.start * pps - scrollLeft;
      const x1 = clip.end * pps - scrollLeft;
      if (x1 < 0 || x0 > width) continue;
      const selected = clip.index === selectedClipIndex;
      const hovered = clip.index === hoveredClipIndex && !selected;
      if (selected) {
        ctx.fillStyle = dark ? "rgba(99, 102, 241, 0.20)" : "rgba(99, 102, 241, 0.10)";
        // Match the selection ring box (vertically inset, rounded).
        roundRectPath(
          ctx,
          x0,
          trackTop + SELECTION_INSET,
          x1 - x0,
          trackH - SELECTION_INSET * 2,
          SELECTION_RADIUS
        );
        ctx.fill();
      } else if (hovered) {
        ctx.fillStyle = dark ? "rgba(99, 102, 241, 0.10)" : "rgba(99, 102, 241, 0.05)";
        ctx.fillRect(x0, trackTop, x1 - x0, trackH);
      }
    }

    // Cut range backgrounds (selected / hovered wash stronger)
    cuts.forEach((cut, cutIndex) => {
      const x0 = cut.start * pps - scrollLeft;
      const x1 = cut.end * pps - scrollLeft;
      if (x1 < 0 || x0 > width) return;
      const selected = cutIndex === selectedCutIndex;
      const hovered = cutIndex === hoveredCutIndex && !selected;
      // Selected fills share the ring's box so the hatch can't spill past the radius.
      const fillX = x0;
      const fillY = selected ? trackTop + SELECTION_INSET : trackTop;
      const fillW = x1 - x0;
      const fillH = selected ? trackH - SELECTION_INSET * 2 : trackH;
      ctx.fillStyle = selected
        ? dark
          ? "rgba(185, 28, 28, 0.62)"
          : "rgba(254, 202, 202, 0.95)"
        : hovered
          ? dark
            ? "rgba(153, 27, 27, 0.55)"
            : "rgba(254, 226, 226, 0.9)"
          : dark
            ? "rgba(127, 29, 29, 0.45)"
            : "rgba(254, 226, 226, 0.78)";
      if (selected) {
        roundRectPath(ctx, fillX, fillY, fillW, fillH, SELECTION_RADIUS);
        ctx.fill();
      } else {
        ctx.fillRect(fillX, fillY, fillW, fillH);
      }
      // subtle hatch — clipped to the same (rounded) shape as the fill
      ctx.save();
      if (selected) {
        roundRectPath(ctx, fillX, fillY, fillW, fillH, SELECTION_RADIUS);
      } else {
        ctx.beginPath();
        ctx.rect(fillX, fillY, fillW, fillH);
      }
      ctx.clip();
      ctx.strokeStyle = selected
        ? dark
          ? "rgba(252, 165, 165, 0.55)"
          : "rgba(248, 113, 113, 0.65)"
        : dark
          ? "rgba(248, 113, 113, 0.35)"
          : "rgba(252, 165, 165, 0.45)";
      ctx.lineWidth = 1;
      for (let x = fillX - fillH; x < fillX + fillW + fillH; x += 6) {
        ctx.beginPath();
        ctx.moveTo(x, fillY);
        ctx.lineTo(x + fillH, fillY + fillH);
        ctx.stroke();
      }
      ctx.restore();
    });

    // Waveform. Drawn from the precomputed min/max envelope rather than the
    // decoded PCM — see lib/waveform.ts. peakBetween already clamps the
    // overshoot hot sources produce, so the bar cannot spill into the wordbar.
    if (!waveform) return;
    const samplesPerPx = VAD_SAMPLE_RATE / pps;
    for (let x = 0; x < width; x++) {
      const t = (scrollLeft + x) / pps;
      if (t > duration) break;
      const i0 = Math.floor(t * VAD_SAMPLE_RATE);
      const peak = peakBetween(waveform, i0, Math.floor(i0 + samplesPerPx) + 1);
      const inCut = cuts.some((c) => t >= c.start && t < c.end);
      ctx.fillStyle = inCut ? "#fca5a5" : "#818cf8";
      const h = Math.max(1, peak * trackH * WAVE_LANE_FILL);
      ctx.fillRect(x, midY - h / 2, 1, h);
    }
  }, [
    waveform,
    cuts,
    clips,
    duration,
    pps,
    scrollLeft,
    width,
    height,
    selectedClipIndex,
    hoveredClipIndex,
    selectedCutIndex,
    hoveredCutIndex,
    dark,
  ]);

  // Panning or zooming during playback hands the window to the user until the
  // next play/pause: `scrollLeft` the follow effect did not write is theirs.
  const userScrolledRef = useRef(false);
  const autoScrollRef = useRef<number | null>(null);
  useEffect(() => {
    userScrolledRef.current = false;
  }, [playing]);

  // Keep the playhead visible while playing.
  useEffect(() => {
    if (!playing || userScrolledRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const px = currentTime * pps;
    if (px < el.scrollLeft + 24 || px > el.scrollLeft + width - 96) {
      el.scrollLeft = Math.max(0, px - 96);
      autoScrollRef.current = el.scrollLeft;
    }
  }, [currentTime, playing, pps, width]);

  // Vertical wheel / pinch zooms (anchored at the pointer); horizontal
  // trackpad side-scroll pans via native overflow-x. Non-passive so zoom
  // can preventDefault.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (durationRef.current <= 0) return;
      // Horizontal intent → pan: don't preventDefault, let native scroll run.
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const curZoom = zoomRef.current;
      const curPps = ppsRef.current;
      if (curPps <= 0) return;
      const rect = el.getBoundingClientRect();
      const pointerX = e.clientX - rect.left;
      const tAnchor = (el.scrollLeft + pointerX) / curPps;
      const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, curZoom * Math.exp(-e.deltaY * ZOOM_SPEED))
      );
      if (nextZoom === curZoom) return;
      const fit =
        widthRef.current > 0 && durationRef.current > 0
          ? widthRef.current / durationRef.current
          : 50;
      const nextPps = fit * nextZoom;
      pendingScrollRef.current = Math.max(0, tAnchor * nextPps - pointerX);
      setZoom(nextZoom);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Apply the anchor-preserving scroll once wheel-zoom has re-rendered.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || pendingScrollRef.current == null) return;
    el.scrollLeft = pendingScrollRef.current;
    pendingScrollRef.current = null;
    setScrollLeft(el.scrollLeft);
  }, [zoom]);

  const timeFromClientX = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      return Math.min(
        Math.max(0, (clientX - rect.left + el.scrollLeft) / pps),
        duration
      );
    },
    [pps, duration]
  );

  const seekTo = useCallback((t: number) => {
    useEditorStore.getState().seekTo(t);
  }, []);

  const endDrag = useCallback(() => {
    if (dragRef.current) {
      useEditorStore.getState().endGesture();
      dragRef.current = null;
      setDragging(false);
    }
  }, []);

  useEffect(() => {
    const onUp = () => endDrag();
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [endDrag]);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const t = timeFromClientX(e.clientX);
      const drag = dragRef.current;
      if (!drag) {
        // Hover clip or cut under cursor (waveform area)
        const clip = clips.find((c) => t >= c.start && t < c.end);
        setHoveredClipIndex(clip?.index ?? null);
        const cutIdx = cuts.findIndex((c) => t >= c.start && t < c.end);
        setHoveredCutIndex(cutIdx >= 0 ? cutIdx : null);
        const split = splits.find(
          (b) => Math.abs(t - b.time) * pps <= SPLIT_HOVER_PX
        );
        setHoveredSplitId(split?.id ?? null);
        return;
      }
      setHoveredSplitId(null);
      const store = useEditorStore.getState();

      if (drag.type === "seek") {
        seekTo(t);
        return;
      }
      if (drag.type === "word") {
        if (drag.edge === "start") {
          store.adjustWordBounds(drag.wordId, t, drag.origEnd);
        } else {
          store.adjustWordBounds(drag.wordId, drag.origStart, t);
        }
        return;
      }
      if (drag.type === "trim") {
        const next = Math.min(Math.max(t, drag.lo), drag.hi);
        if (Math.abs(next - drag.time) < 1e-4) return;
        store.trimEdge(drag.edge, drag.time, next);
        drag.time = next;
        return;
      }
    },
    [clips, cuts, pps, seekTo, splits, timeFromClientX]
  );

  const onPointerLeave = useCallback(() => {
    if (dragRef.current) return;
    setHoveredClipIndex(null);
    setHoveredCutIndex(null);
    setHoveredSplitId(null);
  }, []);

  const joinAtSplit = useCallback((e: ReactPointerEvent | React.MouseEvent, id: number) => {
    e.stopPropagation();
    useEditorStore.getState().removeSceneBoundary(id);
    setHoveredSplitId(null);
  }, []);

  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      // Ignore if clicking interactive chrome (handles / chips set their own drag)
      const target = e.target as HTMLElement;
      if (target.closest("[data-tl-interactive]")) return;

      const t = timeFromClientX(e.clientX);
      const clip = clips.find((c) => t >= c.start && t < c.end);
      const cutIdx = cuts.findIndex((c) => t >= c.start && t < c.end);
      const store = useEditorStore.getState();
      if (cutIdx >= 0) {
        store.setSelectedCutIndex(cutIdx);
        store.setSelectedWords([]);
      } else {
        store.setSelectedClipIndex(clip?.index ?? null);
        store.setSelectedCutIndex(null);
        store.setSelectedWords([]);
      }
      dragRef.current = { type: "seek" };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      seekTo(t);
    },
    [clips, cuts, seekTo, timeFromClientX]
  );

  const startWordDrag = useCallback(
    (e: ReactPointerEvent, word: Word, edge: "start" | "end") => {
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      useEditorStore.getState().beginGesture();
      dragRef.current = {
        type: "word",
        wordId: word.id,
        edge,
        origStart: word.start,
        origEnd: word.end,
      };
      setDragging(true);
    },
    []
  );

  const startTrimDrag = useCallback(
    (e: ReactPointerEvent, clip: ClipSegment, edge: "in" | "out") => {
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const store = useEditorStore.getState();
      store.setSelectedClipIndex(clip.index);
      store.beginGesture();

      // Reclaiming may consume the whole gap next to this clip, but no further:
      // past that lies the neighbour's own handle, and dragging through it used
      // to trim the wrong clip.
      const { lo, hi } = trimEdgeBounds(clip, edge, cuts);
      dragRef.current = {
        type: "trim",
        edge,
        time: edge === "in" ? clip.start : clip.end,
        lo,
        hi,
      };
      setDragging(true);
    },
    [cuts]
  );

  const editedDuration = useMemo(
    () => getEditedDuration(cuts, duration),
    [cuts, duration]
  );
  const trimmed = duration - editedDuration;

  const togglePlay = useCallback(() => {
    useEditorStore.getState().togglePlayback();
  }, []);

  const skip = useCallback((delta: number) => {
    const { videoEl, setCurrentTime } = useEditorStore.getState();
    if (!videoEl) return;
    const t = Math.min(Math.max(0, videoEl.currentTime + delta), videoEl.duration);
    videoEl.currentTime = t;
    setCurrentTime(t);
  }, []);

  // Word labels for the visible window
  const visibleWords = useMemo(() => {
    const t0 = scrollLeft / pps - 1;
    const t1 = (scrollLeft + width) / pps + 1;
    return words.filter((w) => w.end >= t0 && w.start <= t1);
  }, [words, pps, scrollLeft, width]);

  const playheadX = currentTime * pps - scrollLeft;
  const showHandles = pps >= HANDLE_VIS_PPS;

  return (
    <footer className="flex h-48 shrink-0 flex-col border-t border-zinc-200 bg-white sm:h-52 dark:border-zinc-800 dark:bg-zinc-900">
      {/* Mobile wraps the transport onto its own row; from `sm` up it is
          absolutely centred so it stays put as the side groups change width. */}
      <div className="relative flex shrink-0 flex-wrap items-center gap-x-2 border-b border-zinc-100 px-2.5 sm:h-10 sm:flex-nowrap dark:border-zinc-800">
        <div className="order-1 flex h-9 min-w-0 flex-1 items-center gap-2 sm:h-auto">
          <span className="shrink-0 text-[11px] font-mono tabular-nums leading-none text-zinc-900 dark:text-zinc-100">
            {formatTime(originalToEdited(currentTime, cuts))}
            <span className="text-zinc-400 dark:text-zinc-500"> / {formatTime(editedDuration)}</span>
          </span>
          {trimmed > 0.01 && (
            <span
              title={t("timeline.removed", {
                trimmed: formatTime(trimmed),
                duration: formatTime(duration),
              })}
              className="hidden sm:inline-block shrink-0 font-mono rounded-sm bg-red-50 px-1.5 py-0.5 text-[10px] font-medium tabular-nums leading-none text-red-600 dark:bg-red-950/40 dark:text-red-400"
            >
              −{formatTime(trimmed)}
            </span>
          )}
        </div>

        <div className="order-3 -mx-2.5 flex h-9 w-[calc(100%+1.25rem)] items-center justify-center gap-1.5 border-t border-zinc-100 sm:absolute sm:left-1/2 sm:top-1/2 sm:order-2 sm:mx-0 sm:h-auto sm:w-auto sm:-translate-x-1/2 sm:-translate-y-1/2 sm:border-t-0 dark:border-zinc-800">
          <button
            type="button"
            disabled={!ready}
            onClick={() => skip(-5)}
            title={t("timeline.back5")}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-300 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:disabled:text-zinc-600"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={togglePlay}
            title={t("timeline.playPause")}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-zinc-900 transition hover:bg-zinc-100 active:scale-95 disabled:cursor-not-allowed disabled:text-zinc-300 disabled:hover:bg-transparent dark:text-zinc-100 dark:hover:bg-zinc-800 dark:disabled:text-zinc-600"
          >
            {playing ? (
              <Pause size={15} />
            ) : (
              <Play size={15} className="ml-px" />
            )}
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => skip(5)}
            title={t("timeline.forward5")}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-300 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:disabled:text-zinc-600"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        <div className="order-2 flex h-9 items-center justify-end gap-1 sm:order-3 sm:h-auto sm:flex-1">
          <button
            type="button"
            disabled={!ready || !splitOk}
            onClick={() => {
              useEditorStore.getState().splitAtPlayhead();
            }}
            title={
              splitOk
                ? t("timeline.splitTitle")
                : t("timeline.splitDisabled")
            }
            className={`flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition ${
              ready && splitOk
                ? "cursor-pointer text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 active:scale-[0.97] dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                : "cursor-not-allowed text-zinc-300 dark:text-zinc-600"
            }`}
          >
            <SquareSplitHorizontal size={13} />
            <span className="hidden sm:inline">{t("timeline.split")}</span>
            <kbd
              className={`hidden rounded px-1 py-px text-[10px] font-normal sm:inline ${
                ready && splitOk
                  ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                  : "bg-zinc-100 text-zinc-300 dark:bg-zinc-800 dark:text-zinc-600"
              }`}
            >
              S
            </kbd>
          </button>

          <button
            type="button"
            disabled={!ready || !deleteOk}
            onClick={() => {
              useEditorStore.getState().deleteSelectedClip();
            }}
            title={
              deleteOk
                ? t("timeline.deleteTitle")
                : t("timeline.deleteDisabled")
            }
            className={`flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition ${
              ready && deleteOk
                ? "cursor-pointer text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 active:scale-[0.97] dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                : "cursor-not-allowed text-zinc-300 dark:text-zinc-600"
            }`}
          >
            <Trash2 size={13} />
            <span className="hidden sm:inline">{t("timeline.delete")}</span>
            <kbd
              className={`hidden rounded px-1 py-px text-[10px] font-normal sm:inline ${
                ready && deleteOk
                  ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                  : "bg-zinc-100 text-zinc-300 dark:bg-zinc-800 dark:text-zinc-600"
              }`}
            >
              ⌫
            </kbd>
          </button>

          <button
            type="button"
            disabled={!ready || !restoreOk}
            onClick={() => {
              const store = useEditorStore.getState();
              if (store.selectedCutIndex != null) {
                store.restoreSelectedCut();
              } else if (selectedWordsAllCutOut) {
                store.restoreWords(store.selectedWordIds);
                store.setSelectedWords([]);
              }
            }}
            title={
              restoreOk
                ? t("timeline.restoreTitle")
                : t("timeline.restoreDisabled")
            }
            className={`flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition ${
              ready && restoreOk
                ? "cursor-pointer text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 active:scale-[0.97] dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                : "cursor-not-allowed text-zinc-300 dark:text-zinc-600"
            }`}
          >
            <RotateCcw size={13} />
            <span className="hidden sm:inline">{t("timeline.restore")}</span>
            <kbd
              className={`hidden rounded px-1 py-px text-[10px] font-normal sm:inline ${
                ready && restoreOk
                  ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                  : "bg-zinc-100 text-zinc-300 dark:bg-zinc-800 dark:text-zinc-600"
              }`}
            >
              ⌫
            </kbd>
          </button>

          <div className="mx-0.5 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />

          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.5))}
              disabled={zoom <= MIN_ZOOM}
              title={t("timeline.zoomOut")}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-300 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:disabled:text-zinc-600"
            >
              <ZoomOut size={14} />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              disabled={zoom === 1}
              title={t("timeline.fit")}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-300 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:disabled:text-zinc-600"
            >
              <Maximize2 size={13} />
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))}
              disabled={zoom >= MAX_ZOOM}
              title={t("timeline.zoomIn")}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-300 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:disabled:text-zinc-600"
            >
              <ZoomIn size={14} />
            </button>
          </div>
        </div>
      </div>

      <div ref={outerRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />

        <div
          ref={scrollRef}
          onScroll={(e) => {
            const next = e.currentTarget.scrollLeft;
            if (autoScrollRef.current == null || Math.abs(next - autoScrollRef.current) > 1)
              userScrolledRef.current = true;
            autoScrollRef.current = null;
            setScrollLeft(next);
          }}
          onPointerDown={onBackgroundPointerDown}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          className="scrollbar-thin absolute inset-0 touch-none overflow-x-auto overflow-y-hidden select-none"
          style={{ cursor: dragging ? "col-resize" : "default" }}
        >
          <div className="relative h-full" style={{ width: totalWidth }}>
            {/* Split markers between touching clips — hover to reveal "join" */}
            {splits.map((b) => {
              const hovered = hoveredSplitId === b.id;
              return (
                <div
                  key={`split-${b.id}`}
                  className="pointer-events-none absolute z-[8] flex -translate-x-1/2 justify-center items-center"
                  style={{ left: b.time * pps, top: RULER_H + WORDBAR_H + 4, bottom: 0, width: 18 }}
                >
                  {hovered && (
                    <button
                      type="button"
                      data-tl-interactive
                      title={t("timeline.joinClips")}
                      aria-label={t("transcript.joinClips")}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => joinAtSplit(e, b.id)}
                      className="pointer-events-auto flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-500 shadow-sm transition hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                    >
                      <Merge size={9} />
                    </button>
                  )}
                </div>
              );
            })}

            {/* Selected cut/silence outline */}
            {selectedCutIndex != null && cuts[selectedCutIndex] && (
              <div
                className="pointer-events-none absolute z-[4] rounded-sm ring-1 ring-red-400/55 dark:ring-red-300/50"
                style={{
                  left: cuts[selectedCutIndex].start * pps,
                  width: Math.max(
                    2,
                    (cuts[selectedCutIndex].end - cuts[selectedCutIndex].start) * pps
                  ),
                  top: RULER_H + WORDBAR_H + SELECTION_INSET,
                  bottom: SELECTION_INSET,
                }}
              />
            )}

            {/* Clip trim handles (selected or hovered) */}
            {clips.map((clip) => {
              const active =
                clip.index === selectedClipIndex || clip.index === hoveredClipIndex;
              if (!active) return null;
              const selected = clip.index === selectedClipIndex;
              return (
                <div key={`trim-${clip.id}`}>
                  <div
                    data-tl-interactive
                    onPointerDown={(e) => startTrimDrag(e, clip, "in")}
                    className="tl-trim-handle absolute z-[6] -translate-x-1/2 cursor-ew-resize"
                    style={{
                      left: clip.start * pps,
                      top: RULER_H + WORDBAR_H + 4,
                      bottom: 4,
                      opacity: selected ? 1 : 0.7,
                    }}
                    title={t("timeline.trimStart")}
                  >
                    <div
                      className={`h-full w-1 rounded-full transition-all duration-150 ${
                        selected
                          ? "bg-indigo-500 shadow-[0_0_0_3px_rgba(99,102,241,0.2)]"
                          : "bg-indigo-400/80"
                      }`}
                    />
                  </div>
                  <div
                    data-tl-interactive
                    onPointerDown={(e) => startTrimDrag(e, clip, "out")}
                    className="tl-trim-handle absolute z-[6] -translate-x-1/2 cursor-ew-resize"
                    style={{
                      left: clip.end * pps,
                      top: RULER_H + WORDBAR_H + 4,
                      bottom: 4,
                      opacity: selected ? 1 : 0.7,
                    }}
                    title={t("timeline.trimEnd")}
                  >
                    <div
                      className={`h-full w-1 rounded-full transition-all duration-150 ${
                        selected
                          ? "bg-indigo-500 shadow-[0_0_0_3px_rgba(99,102,241,0.2)]"
                          : "bg-indigo-400/80"
                      }`}
                    />
                  </div>
                  {selected && (
                    <div
                      className="pointer-events-none absolute z-[4] rounded-sm ring-1 ring-indigo-400/55 dark:ring-indigo-300/50"
                      style={{
                        left: clip.start * pps,
                        width: Math.max(2, (clip.end - clip.start) * pps),
                        top: RULER_H + WORDBAR_H + SELECTION_INSET,
                        bottom: SELECTION_INSET,
                      }}
                    />
                  )}
                </div>
              );
            })}

            {/* Wordbar chips */}
            {visibleWords.map((w) => {
              const wWidth = Math.max(6, (w.end - w.start) * pps - 1);
              const hovered = hoveredWordId === w.id;
              const cutOut = isWordCutOut(w, cuts);
              const wordSelected = selectedWordIds.includes(w.id);
              const placeholder = isDisfluencyPlaceholder(w.text);
              const showWordHandles = showHandles && (hovered || wWidth > 28);
              return (
                <div
                  key={w.id}
                  data-tl-interactive
                  className={`tl-word absolute z-[3] flex items-center overflow-hidden rounded-md border text-[10px] leading-none transition-[box-shadow,background-color,border-color] duration-150 ${
                    cutOut
                      ? "border-red-200/90 bg-red-50/95 text-red-400 line-through dark:border-red-900/90 dark:bg-red-950/60 dark:text-red-400"
                      : wordSelected
                        ? "border-indigo-300 bg-indigo-100/70 text-zinc-800 dark:border-indigo-500/60 dark:bg-indigo-950/50 dark:text-zinc-100"
                        : placeholder
                          ? hovered
                            ? "border-amber-300/90 bg-amber-50 text-amber-800 shadow-sm shadow-amber-500/10 dark:border-amber-700/80 dark:bg-amber-950/50 dark:text-amber-300"
                            : "border-amber-200/90 bg-amber-50/90 text-amber-700/90 dark:border-amber-800/80 dark:bg-amber-950/40 dark:text-amber-400/90"
                          : hovered
                            ? "border-neutral-300 bg-white text-zinc-700 shadow-sm shadow-neutral-500/10 dark:border-neutral-600 dark:bg-zinc-800 dark:text-zinc-200 dark:shadow-black/20"
                            : "border-zinc-200/90 bg-white/95 text-zinc-600 dark:border-zinc-700/90 dark:bg-zinc-800/95 dark:text-zinc-300"
                  } ${wordSelected ? "ring-1 ring-indigo-400/80" : ""}`}
                  style={{
                    left: w.start * pps,
                    top: RULER_H + 5,
                    width: wWidth,
                    height: WORDBAR_H - 10,
                  }}
                  title={
                    placeholder
                      ? showHandles
                        ? t("timeline.hesitationAdjust")
                        : t("timeline.hesitationCut")
                      : showHandles
                        ? t("timeline.dragTiming", { word: w.text })
                        : w.text
                  }
                  onPointerEnter={() => setHoveredWordId(w.id)}
                  onPointerLeave={() =>
                    setHoveredWordId((id) => (id === w.id ? null : id))
                  }
                  onPointerDown={(e) => {
                    // Clicking the chip body seeks to word start (not a bound drag)
                    if ((e.target as HTMLElement).dataset.edge) return;
                    e.stopPropagation();
                    seekTo(w.start);
                    const store = useEditorStore.getState();
                    // Select the word (the transcript mirrors this). Kept words
                    // also select their clip; cut-out words select the cut so
                    // Delete / Restore can bring them back.
                    store.setSelectedWords([w.id]);
                    if (cutOut) {
                      const cut = cutRangeAt(w.start + (w.end - w.start) / 2, cuts);
                      const cutIdx = cut
                        ? cuts.findIndex(
                            (c) =>
                              Math.abs(c.start - cut.start) < 1e-4 &&
                              Math.abs(c.end - cut.end) < 1e-4
                          )
                        : -1;
                      if (cutIdx >= 0) store.setSelectedCutIndex(cutIdx);
                      else {
                        store.setSelectedCutIndex(null);
                        store.setSelectedClipIndex(null);
                      }
                    } else {
                      const clip = clips.find(
                        (c) => w.start >= c.start && w.start < c.end
                      );
                      store.setSelectedClipIndex(clip?.index ?? null);
                      store.setSelectedCutIndex(null);
                    }
                  }}
                >
                  <span className="pointer-events-none min-w-0 flex-1 truncate px-1.5">
                    {w.text}
                  </span>
                  {showWordHandles && (
                    <>
                      <span
                        data-edge="start"
                        data-tl-interactive
                        onPointerDown={(e) => startWordDrag(e, w, "start")}
                        className="tl-word-handle absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize"
                      >
                        <span
                          className={`absolute inset-y-1 left-0 w-0.5 rounded-full transition-all duration-150 ${
                            cutOut
                              ? "bg-red-400/70"
                              : hovered
                                ? "bg-neutral-500 opacity-100 dark:bg-neutral-300"
                                : "bg-zinc-300 opacity-0 group-hover:opacity-100 dark:bg-zinc-600"
                          }`}
                          style={{ opacity: hovered ? 1 : 0.55 }}
                        />
                      </span>
                      <span
                        data-edge="end"
                        data-tl-interactive
                        onPointerDown={(e) => startWordDrag(e, w, "end")}
                        className="tl-word-handle absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize"
                      >
                        <span
                          className={`absolute inset-y-1 right-0 w-0.5 rounded-full transition-all duration-150 ${
                            cutOut
                              ? "bg-red-400/70"
                              : hovered
                                ? "bg-neutral-500 opacity-100 dark:bg-neutral-300"
                                : "bg-zinc-300 opacity-0 group-hover:opacity-100 dark:bg-zinc-600"
                          }`}
                          style={{ opacity: hovered ? 1 : 0.55 }}
                        />
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {playheadX >= -2 && playheadX <= width + 2 && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-zinc-900/90 dark:bg-zinc-100/90"
            style={{ transform: `translateX(${playheadX}px)` }}
          >
            <div className="absolute -top-px left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-sm bg-zinc-900 shadow-sm shadow-zinc-900/30 [clip-path:polygon(0_0,100%_0,100%_55%,50%_100%,0_55%)] dark:bg-zinc-100 dark:shadow-black/40" />
          </div>
        )}

        {pps < SMALL_PPS && ready && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-zinc-900/70 px-2.5 py-1 text-[10px] text-white/90 backdrop-blur-sm transition-opacity dark:bg-zinc-100/80 dark:text-zinc-900">
            {t("timeline.scrollZoom")}
          </div>
        )}
      </div>
    </footer>
  );
}
