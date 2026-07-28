"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { formatTime, getEffectiveCuts } from "@/lib/edits";

const RULER_H = 20;
const LABELS_H = 20;
const SAMPLE_RATE = 16000;
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_ZOOM = 1;
const MAX_ZOOM = 256;
/** Wheel-zoom sensitivity (higher = faster zoom per scroll tick). */
const ZOOM_SPEED = 0.0028;
/** Grab width (px) of a cut-edge handle's hit area. */
const HANDLE_HIT = 14;
/** Smallest cut a drag may leave, so edges never invert. */
const MIN_CUT = 0.03;

export default function Timeline() {
  const audio = useEditorStore((s) => s.audio);
  const words = useEditorStore((s) => s.words);
  const duration = useEditorStore((s) => s.duration);
  const currentTime = useEditorStore((s) => s.currentTime);
  const playing = useEditorStore((s) => s.playing);
  const cutAdjustments = useEditorStore((s) => s.cutAdjustments);

  const cuts = useMemo(
    () => getEffectiveCuts(words, duration, cutAdjustments),
    [words, duration, cutAdjustments]
  );

  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState(1); // multiplier over "fit"

  const fitPps = duration > 0 && width > 0 ? width / duration : 50;
  const pps = fitPps * zoom;
  const totalWidth = Math.max(width, duration * pps);

  // Live mirrors for the imperative wheel/drag handlers (avoid stale closures).
  const ppsRef = useRef(pps);
  const zoomRef = useRef(zoom);
  const widthRef = useRef(width);
  const durationRef = useRef(duration);
  const cutsRef = useRef(cuts);
  useEffect(() => {
    ppsRef.current = pps;
    zoomRef.current = zoom;
    widthRef.current = width;
    durationRef.current = duration;
    cutsRef.current = cuts;
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

  // Draw ruler + waveform + cut overlay for the visible window.
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

    const trackTop = RULER_H + LABELS_H;
    const trackH = height - trackTop;
    const midY = trackTop + trackH / 2;

    // Ruler
    ctx.fillStyle = "#a1a1aa";
    ctx.font = "9px ui-sans-serif, system-ui";
    ctx.textBaseline = "top";
    const step = TICK_STEPS.find((s) => s * pps >= 70) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const firstTick = Math.floor(scrollLeft / pps / step) * step;
    for (let t = firstTick; t <= (scrollLeft + width) / pps + step; t += step) {
      const x = t * pps - scrollLeft;
      ctx.fillStyle = "#e4e4e7";
      ctx.fillRect(x, RULER_H - 6, 1, 6);
      ctx.fillStyle = "#a1a1aa";
      ctx.fillText(formatTime(t), x + 4, 3);
    }
    ctx.strokeStyle = "#f0f0f2";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(width, RULER_H - 0.5);
    ctx.stroke();

    if (!audio || duration === 0) return;

    // Cut range backgrounds
    for (const cut of cuts) {
      const x0 = cut.start * pps - scrollLeft;
      const x1 = cut.end * pps - scrollLeft;
      if (x1 < 0 || x0 > width) continue;
      ctx.fillStyle = "rgba(254, 226, 226, 0.85)";
      ctx.fillRect(x0, trackTop, x1 - x0, trackH);
    }

    // Waveform: per-column min/max, sampled with a stride to bound work.
    const samplesPerPx = SAMPLE_RATE / pps;
    const stride = Math.max(1, Math.floor(samplesPerPx / 40));
    for (let x = 0; x < width; x++) {
      const t = (scrollLeft + x) / pps;
      if (t > duration) break;
      const i0 = Math.floor(t * SAMPLE_RATE);
      const i1 = Math.min(audio.length, Math.floor(i0 + samplesPerPx) + 1);
      let min = 0;
      let max = 0;
      for (let i = i0; i < i1; i += stride) {
        const v = audio[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const inCut = cuts.some((c) => t >= c.start && t < c.end);
      ctx.fillStyle = inCut ? "#fca5a5" : "#818cf8";
      const h = Math.max(1, (max - min) * trackH * 0.45);
      ctx.fillRect(x, midY - h / 2, 1, h);
    }
  }, [audio, cuts, duration, pps, scrollLeft, width, height]);

  // Keep the playhead visible while playing.
  useEffect(() => {
    if (!playing) return;
    const el = scrollRef.current;
    if (!el) return;
    const px = currentTime * pps;
    if (px < el.scrollLeft + 24 || px > el.scrollLeft + width - 96) {
      el.scrollLeft = Math.max(0, px - 96);
    }
  }, [currentTime, playing, pps, width]);

  // Vertical wheel / pinch zooms (anchored at the pointer so the point under
  // the cursor stays put); horizontal trackpad side-scroll pans the track by
  // letting the browser scroll the overflow-x container natively. Registered
  // as a non-passive listener so the zoom branch can preventDefault.
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

  // Apply the anchor-preserving scroll once the wheel-zoom has re-rendered the
  // (wider/narrower) track. Runs before paint to avoid a visible jump.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || pendingScrollRef.current == null) return;
    el.scrollLeft = pendingScrollRef.current;
    pendingScrollRef.current = null;
    setScrollLeft(el.scrollLeft);
  }, [zoom]);

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const t = Math.min(
        Math.max(0, (clientX - rect.left + el.scrollLeft) / pps),
        duration
      );
      const { videoEl, setCurrentTime } = useEditorStore.getState();
      if (videoEl) videoEl.currentTime = t;
      setCurrentTime(t);
    },
    [pps, duration]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      seekFromPointer(e.clientX);
    },
    [seekFromPointer]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.buttons & 1) seekFromPointer(e.clientX);
    },
    [seekFromPointer]
  );

  // --- Cut-edge handle dragging ------------------------------------------
  const dragRef = useRef<{ key: number; edge: "start" | "end"; pushed: boolean } | null>(
    null
  );

  const timeFromClientX = useCallback((clientX: number) => {
    const el = scrollRef.current;
    if (!el || ppsRef.current <= 0) return 0;
    const rect = el.getBoundingClientRect();
    return (clientX - rect.left + el.scrollLeft) / ppsRef.current;
  }, []);

  const onHandleDown = useCallback(
    (e: React.PointerEvent, key: number, edge: "start" | "end") => {
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { key, edge, pushed: false };
    },
    []
  );

  const onHandleMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.stopPropagation();
      const list = cutsRef.current;
      const idx = list.findIndex((c) => c.key === drag.key);
      if (idx === -1) return;
      const cut = list[idx];
      const prev = list[idx - 1];
      const next = list[idx + 1];
      let t = timeFromClientX(e.clientX);
      if (drag.edge === "start") {
        const lo = prev ? prev.end : 0;
        const hi = Math.max(lo, cut.end - MIN_CUT);
        t = Math.min(Math.max(t, lo), hi);
      } else {
        const hi = next ? next.start : durationRef.current;
        const lo = Math.min(hi, cut.start + MIN_CUT);
        t = Math.min(Math.max(t, lo), hi);
      }
      const { adjustCut, videoEl, setCurrentTime } = useEditorStore.getState();
      adjustCut(drag.key, drag.edge, t, !drag.pushed);
      drag.pushed = true;
      // Scrub the preview to the edge for precise, audible/visible trimming.
      if (videoEl) videoEl.currentTime = t;
      setCurrentTime(t);
    },
    [timeFromClientX]
  );

  const onHandleUp = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }, []);

  const onHandleReset = useCallback(
    (e: React.MouseEvent, key: number) => {
      e.stopPropagation();
      useEditorStore.getState().resetCutAdjust(key);
    },
    []
  );

  // Word labels for the visible window (only when zoomed in enough to read).
  const visibleWords = useMemo(() => {
    if (pps < 18) return [];
    const t0 = scrollLeft / pps - 1;
    const t1 = (scrollLeft + width) / pps + 1;
    return words.filter((w) => w.end >= t0 && w.start <= t1);
  }, [words, pps, scrollLeft, width]);

  // Only mount handles for cuts intersecting the viewport (bounds DOM nodes).
  const visibleCuts = useMemo(() => {
    if (width === 0) return cuts;
    const t0 = scrollLeft / pps - 1;
    const t1 = (scrollLeft + width) / pps + 1;
    return cuts.filter((c) => c.end >= t0 && c.start <= t1);
  }, [cuts, pps, scrollLeft, width]);

  const playheadX = currentTime * pps - scrollLeft;
  const handleTop = RULER_H;

  return (
    <footer className="flex h-44 shrink-0 flex-col border-t border-zinc-200 bg-white">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-100 px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Timeline
        </span>
        <span className="text-xs tabular-nums text-zinc-400">{formatTime(currentTime)}</span>
        <span className="hidden text-[11px] text-zinc-300 sm:inline">
          scroll to zoom · side-scroll to pan · drag cut edges to trim
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.5))}
            title="Zoom out"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={() => setZoom(1)}
            title="Fit"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <Maximize2 size={13} />
          </button>
          <button
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))}
            title="Zoom in"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </div>

      <div ref={outerRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

        <div
          ref={scrollRef}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          className="scrollbar-thin absolute inset-0 cursor-col-resize touch-none overflow-x-auto overflow-y-hidden select-none"
        >
          <div className="relative h-full" style={{ width: totalWidth }}>
            {visibleWords.map((w) => (
              <span
                key={w.id}
                title={w.text}
                className={`absolute block overflow-hidden rounded-sm border px-1 text-[10px] leading-[14px] text-ellipsis whitespace-nowrap ${
                  w.deleted
                    ? "border-red-200 bg-red-50 text-red-400 line-through"
                    : "border-zinc-200 bg-white text-zinc-600"
                }`}
                style={{
                  left: w.start * pps,
                  top: RULER_H + 2,
                  width: Math.max(5, (w.end - w.start) * pps - 1),
                  height: 16,
                }}
              >
                {w.text}
              </span>
            ))}

            {visibleCuts.map((cut) => {
              const adjusted = Boolean(cutAdjustments[cut.key]);
              return (
                <div key={cut.key}>
                  {(["start", "end"] as const).map((edge) => (
                    <div
                      key={edge}
                      aria-label={`Drag to trim cut ${edge}`}
                      onPointerDown={(e) => onHandleDown(e, cut.key, edge)}
                      onPointerMove={onHandleMove}
                      onPointerUp={onHandleUp}
                      onPointerCancel={onHandleUp}
                      onDoubleClick={(e) => onHandleReset(e, cut.key)}
                      title={
                        adjusted
                          ? `Drag to trim · double-click to reset (cut ${edge})`
                          : `Drag to trim the cut ${edge}`
                      }
                      className="group absolute z-20 flex touch-none cursor-ew-resize justify-center"
                      style={{
                        left: cut[edge] * pps - HANDLE_HIT / 2,
                        top: handleTop,
                        bottom: 0,
                        width: HANDLE_HIT,
                      }}
                    >
                      <span
                        className={`pointer-events-none h-full w-0.5 rounded-full transition-colors group-hover:w-1 ${
                          adjusted ? "bg-red-500" : "bg-red-400/70 group-hover:bg-red-500"
                        }`}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {playheadX >= 0 && playheadX <= width && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-zinc-900"
            style={{ transform: `translateX(${playheadX}px)` }}
          >
            <div className="absolute -top-px left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-sm bg-zinc-900 [clip-path:polygon(0_0,100%_0,100%_55%,50%_100%,0_55%)]" />
          </div>
        )}
      </div>
    </footer>
  );
}
