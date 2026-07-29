"use client";

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, FileText, Pencil, RotateCcw, Scissors, WandSparkles, X } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { findFillerWordIds } from "@/lib/fillers";
import type { ParsedTranscript } from "@/lib/parseTranscript";
import type { SpeakerTurn, Word } from "@/lib/types";
import PasteTranscriptDialog from "./PasteTranscriptDialog";

export const SPEAKER_COLORS = [
  "#16a34a", // green
  "#2563eb", // blue
  "#9333ea", // purple
  "#ea580c", // orange
  "#0d9488", // teal
  "#db2777", // pink
];

export const speakerColor = (i: number) =>
  SPEAKER_COLORS[Math.max(0, i) % SPEAKER_COLORS.length];

function findActiveWordId(words: Word[], t: number): number {
  // Binary search for the last word starting at or before t.
  let lo = 0;
  let hi = words.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx >= 0 && t < words[idx].end + 0.15) return words[idx].id;
  return -1;
}

const WordSpan = memo(function WordSpan({
  word,
  active,
  onClick,
}: {
  word: Word;
  active: boolean;
  onClick: (word: Word) => void;
}) {
  // The trailing space lives inside the span so that selection and deletion
  // highlights are continuous across words instead of breaking at each gap.
  return (
    <span
      data-wid={word.id}
      onClick={() => onClick(word)}
      className={`py-0.5 cursor-pointer transition-colors duration-75 ${word.deleted
        ? "word-deleted bg-red-50 text-red-400 line-through decoration-red-300"
        : active
          ? "bg-neutral-200/80 text-zinc-900"
          : "text-zinc-800 hover:bg-neutral-50"
        }`}
    >
      {word.text}{" "}
    </span>
  );
});

interface SelectionInfo {
  ids: number[];
  anyDeleted: boolean;
  anyKept: boolean;
  top: number;
  left: number;
}

export default function TranscriptPanel() {
  const words = useEditorStore((s) => s.words);
  const status = useEditorStore((s) => s.status);
  const progress = useEditorStore((s) => s.progress);
  const partialText = useEditorStore((s) => s.partialText);
  const error = useEditorStore((s) => s.error);
  const showDeleted = useEditorStore((s) => s.showDeleted);
  const toggleShowDeleted = useEditorStore((s) => s.toggleShowDeleted);
  const deleteWords = useEditorStore((s) => s.deleteWords);
  const restoreWords = useEditorStore((s) => s.restoreWords);
  const correctWords = useEditorStore((s) => s.correctWords);
  const importWords = useEditorStore((s) => s.importWords);
  const playing = useEditorStore((s) => s.playing);
  const activeWordId = useEditorStore((s) => findActiveWordId(s.words, s.currentTime));

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [correcting, setCorrecting] = useState<{
    ids: number[];
    top: number;
    left: number;
    containerWidth: number;
  } | null>(null);
  const [correctText, setCorrectText] = useState("");
  // Mirrors `correcting` so the selectionchange handler (which has its own
  // dependency list) can freeze the highlight while the popover is open.
  const correctingRef = useRef(false);

  const turns = useMemo<SpeakerTurn[]>(() => {
    const out: SpeakerTurn[] = [];
    for (const w of words) {
      const last = out[out.length - 1];
      if (last && last.speaker === w.speaker) last.words.push(w);
      else out.push({ speaker: w.speaker, words: [w] });
    }
    return out;
  }, [words]);

  const deletedCount = useMemo(() => words.filter((w) => w.deleted).length, [words]);
  const fillerIds = useMemo(() => findFillerWordIds(words), [words]);

  const removeFillers = useCallback(() => {
    deleteWords(fillerIds);
  }, [deleteWords, fillerIds]);

  const handleImportParsed = useCallback(
    async (parsed: ParsedTranscript) => {
      if (
        words.length > 0 &&
        !confirm("Replace the current transcript with this one?")
      ) {
        return false;
      }
      if (parsed.kind === "timed") {
        importWords(parsed.words);
        return;
      }
      // Plain text (Descript-style): align to existing timings when we have
      // them; otherwise run Whisper and sync the reference text onto it.
      const state = useEditorStore.getState();
      if (state.words.length > 0) {
        const { alignTranscript } = await import("@/lib/alignTranscript");
        const aligned = alignTranscript(
          parsed.tokens,
          state.words,
          state.duration
        );
        importWords(aligned);
        return;
      }
      if (!state.audio) {
        throw new Error("Wait for the media to finish loading, then try again.");
      }
      state.setSyncTokens(parsed.tokens);
      const { startTranscription } = await import("@/hooks/useTranscriber");
      startTranscription(
        state.audio,
        state.duration || state.audio.length / 16000
      );
    },
    [words.length, importWords]
  );

  const seekToWord = useCallback((word: Word) => {
    const { videoEl, setCurrentTime } = useEditorStore.getState();
    if (videoEl) videoEl.currentTime = word.start + 0.001;
    setCurrentTime(word.start + 0.001);
  }, []);

  // Track text selection over word spans, position the floating toolbar, and
  // paint our own (dimmed, gap-free) highlight by marking the selected spans.
  // The native ::selection highlight is made transparent over the words, and
  // the marking is done imperatively so dragging doesn't re-render the panel.
  const markedRef = useRef<Set<HTMLElement>>(new Set());
  useEffect(() => {
    const clearMarks = () => {
      for (const el of markedRef.current) el.removeAttribute("data-sel");
      markedRef.current.clear();
    };
    const handler = () => {
      // Keep the highlight frozen on the words being corrected.
      if (correctingRef.current) return;
      const container = containerRef.current;
      const sel = window.getSelection();
      if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        clearMarks();
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        clearMarks();
        setSelection(null);
        return;
      }
      const wordMap = new Map(words.map((w) => [w.id, w]));
      const ids: number[] = [];
      let anyDeleted = false;
      let anyKept = false;
      const marked = new Set<HTMLElement>();
      container.querySelectorAll<HTMLElement>("[data-wid]").forEach((el) => {
        if (range.intersectsNode(el)) {
          const id = Number(el.dataset.wid);
          ids.push(id);
          el.setAttribute("data-sel", "");
          marked.add(el);
          const w = wordMap.get(id);
          if (w?.deleted) anyDeleted = true;
          else anyKept = true;
        }
      });
      for (const el of markedRef.current) {
        if (!marked.has(el)) el.removeAttribute("data-sel");
      }
      markedRef.current = marked;
      if (ids.length === 0) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setSelection({
        ids,
        anyDeleted,
        anyKept,
        top: rect.top - containerRect.top - 44,
        left: Math.max(8, rect.left - containerRect.left + rect.width / 2),
      });
    };
    document.addEventListener("selectionchange", handler);
    return () => {
      clearMarks();
      document.removeEventListener("selectionchange", handler);
    };
  }, [words]);

  const cutSelection = useCallback(() => {
    if (!selection) return;
    deleteWords(selection.ids);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, [selection, deleteWords]);

  const restoreSelection = useCallback(() => {
    if (!selection) return;
    restoreWords(selection.ids);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, [selection, restoreWords]);

  const openCorrect = useCallback(() => {
    if (!selection) return;
    const idSet = new Set(selection.ids);
    const text = words
      .filter((w) => idSet.has(w.id))
      .map((w) => w.text)
      .join(" ");
    correctingRef.current = true;
    setCorrectText(text);
    setCorrecting({
      ids: selection.ids,
      top: selection.top,
      left: selection.left,
      containerWidth: containerRef.current?.clientWidth ?? 640,
    });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, words]);

  const closeCorrect = useCallback(() => {
    correctingRef.current = false;
    for (const el of markedRef.current) el.removeAttribute("data-sel");
    markedRef.current.clear();
    setCorrecting(null);
  }, []);

  const applyCorrection = useCallback(() => {
    if (!correcting) return;
    correctWords(correcting.ids, correctText);
    closeCorrect();
  }, [correcting, correctText, correctWords, closeCorrect]);

  // Close the correction popover when clicking outside of it.
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!correcting) return;
    const handler = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) closeCorrect();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [correcting, closeCorrect]);

  // Delete / Backspace cuts the selected words.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;
      if (!selection || selection.ids.length === 0) return;
      e.preventDefault();
      cutSelection();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selection, cutSelection]);

  // Keep the active word in view during playback.
  useEffect(() => {
    if (!playing || activeWordId < 0) return;
    const el = containerRef.current?.querySelector(`[data-wid="${activeWordId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeWordId, playing]);

  const busy = status === "preparing" || status === "transcribing";

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-100 px-3 sm:px-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Transcript
        </span>
        <div className="ml-auto flex items-center gap-2">
          {status === "ready" && (
            <span className="hidden text-xs text-zinc-400 md:inline">
              select words and press ⌫ to cut
            </span>
          )}
          {deletedCount > 0 && (
            <span className="rounded-md bg-red-50 px-2 py-0.5 text-[9px] font-medium text-red-500">
              {deletedCount} word{deletedCount === 1 ? "" : "s"} cut
            </span>
          )}
          {status === "ready" && fillerIds.length > 0 && (
            <button
              onClick={removeFillers}
              title='Cut filler words ("um", "uh", …) from the video'
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition hover:bg-zinc-100"
            >
              <WandSparkles size={14} />
              <span className="hidden sm:inline">Remove fillers </span>({fillerIds.length})
            </button>
          )}
          {(status === "ready" || status === "error" || status === "transcribing") && (
            <>
              <button
                onClick={() => setImportOpen(true)}
                title="Paste or import SRT, VTT, JSON, or TXT"
                className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition hover:bg-zinc-100"
              >
                <FileText size={14} />
                <span className="hidden sm:inline">Import</span>
              </button>
              {importOpen && (
                <PasteTranscriptDialog
                  open
                  title="Replace transcript"
                  submitLabel={words.length > 0 ? "Sync transcript" : "Use transcript"}
                  onClose={() => setImportOpen(false)}
                  onParsed={handleImportParsed}
                />
              )}
            </>
          )}
          <button
            onClick={toggleShowDeleted}
            title={showDeleted ? "Hide deleted words" : "Show deleted words"}
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition hover:bg-zinc-100"
          >
            {showDeleted ? <Eye size={14} /> : <EyeOff size={14} />}
            <span className="hidden sm:inline">
              {showDeleted ? "Showing cuts" : "Hiding cuts"}
            </span>
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div ref={containerRef} className="relative mx-auto max-w-2xl px-4 py-6 sm:px-8 sm:py-8">
          {busy && (
            <div className="flex flex-col items-start gap-4">
              <div className="w-full bg-zinc-50 p-2">
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent" />
                  <p className="text-sm font-medium text-zinc-700">{progress.message}</p>
                  {progress.value !== null && (
                    <>
                      <div className="ml-auto w-[100px] h-1 overflow-hidden rounded-full bg-zinc-200">
                        <div
                          className="h-full rounded-full bg-neutral-500 transition-[width] duration-300"
                          style={{ width: `${progress.value * 100}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-zinc-400">
                        {Math.round(progress.value * 100)}%
                      </span>
                    </>
                  )}
                </div>
              </div>
              {partialText && (
                <p className="text-[15px] leading-8 text-zinc-400">
                  {partialText}
                  <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-neutral-500 align-middle" />
                </p>
              )}
            </div>
          )}

          {status === "error" && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
              {error}
            </div>
          )}

          {status === "ready" && (
            <div className="transcript-words selection:bg-transparent">
              {turns.map((turn, i) => {
                const visible = showDeleted ? turn.words : turn.words.filter((w) => !w.deleted);
                if (visible.length === 0) return null;
                return (
                  <div key={i} className="mb-7">
                    <div
                      className="mb-1.5 text-[13px] font-semibold"
                      style={{ color: speakerColor(turn.speaker) }}
                    >
                      Speaker {turn.speaker + 1}
                    </div>
                    <p className="select-text text-[15px] leading-8">
                      {visible.map((w) => (
                        <WordSpan
                          key={w.id}
                          word={w}
                          active={w.id === activeWordId}
                          onClick={seekToWord}
                        />
                      ))}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {selection && !correcting && (
            <div
              className="absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-zinc-200 bg-white p-1 shadow-lg shadow-zinc-900/10"
              style={{ top: selection.top, left: selection.left }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {selection.anyKept && (
                <button
                  onClick={cutSelection}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-zinc-700 transition hover:bg-red-50 hover:text-red-600"
                >
                  <Scissors size={13} />
                  Cut
                </button>
              )}
              <button
                onClick={openCorrect}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-zinc-700 transition hover:bg-zinc-100"
              >
                <Pencil size={13} />
                Correct
              </button>
              {selection.anyDeleted && (
                <button
                  onClick={restoreSelection}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-zinc-700 transition hover:bg-emerald-50 hover:text-emerald-600"
                >
                  <RotateCcw size={13} />
                  Restore
                </button>
              )}
            </div>
          )}

          {correcting && (
            <div
              ref={popoverRef}
              className="absolute z-20 w-80 max-w-[calc(100%-16px)] -translate-x-1/2 rounded-2xl border border-zinc-200 bg-white p-3 shadow-xl shadow-zinc-900/10"
              style={{
                top: Math.max(4, correcting.top - 56),
                left: Math.min(
                  Math.max(168, correcting.left),
                  correcting.containerWidth - 168
                ),
              }}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-zinc-800">Correct</span>
                <button
                  onClick={closeCorrect}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
                >
                  <X size={13} />
                </button>
              </div>
              <input
                autoFocus
                value={correctText}
                onChange={(e) => setCorrectText(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCorrection();
                  else if (e.key === "Escape") closeCorrect();
                }}
                className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2.5 py-1.5 text-sm text-zinc-800 outline-none focus:border-zinc-500 focus:bg-white"
              />
              <div className="mt-2.5 flex justify-end">
                <button
                  onClick={applyCorrection}
                  disabled={correctText.trim().length === 0}
                  className="flex h-8 items-center rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40"
                >
                  Correct
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
