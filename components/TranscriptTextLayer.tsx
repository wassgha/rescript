"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { activeWordOf, seekToWord, useEditorStore } from "@/lib/store";
import { isDisfluencyPlaceholder } from "@/lib/disfluencies";
import { speakerLabel } from "@/lib/speakers";
import { groupWordsBySpeaker } from "@/lib/transcript";
import {
  buildTranscriptText,
  wordIdAtCaret,
  wordIdBeforeCaret,
  wordIdForDelete,
  wordIdsInRange,
  wordStartOffset,
} from "@/lib/transcriptText";
import { localizedSpeakerName } from "./SpeakerLabel";
import { useI18n } from "./I18nProvider";

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Screen-reader bridge for the transcript (issue #104). The visual transcript
 * is one span per word, which NVDA / VoiceOver can't read as editable text, so
 * this keeps a visually hidden native textarea in sync with the kept words.
 * Caret moves seek the playhead, selections select words, Backspace / Delete
 * cut words, Enter opens Correct, Space plays / pauses, Cut / Copy / Paste move
 * and duplicate words, and undo / redo go through the editor's history. Typing
 * is blocked — the text only changes through edits, so it always matches what
 * will be exported.
 */
export default function TranscriptTextLayer({
  cutOutIds,
  onCorrect,
}: {
  cutOutIds: Set<number>;
  /** Open the Correct popover; focus should return to `returnFocus` on close. */
  onCorrect: (ids: number[], returnFocus: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const words = useEditorStore((s) => s.words);
  const speakers = useEditorStore((s) => s.speakers);
  const hintId = useId();

  const { text, segments } = useMemo(
    () =>
      buildTranscriptText(
        groupWordsBySpeaker(words.filter((w) => !cutOutIds.has(w.id))),
        (id) => localizedSpeakerName(speakerLabel(speakers, id), t),
        (word) => (isDisfluencyPlaceholder(word) ? t("transcript.textHesitation") : word)
      ),
    [words, cutOutIds, speakers, t]
  );

  const ref = useRef<HTMLTextAreaElement>(null);
  // The textarea's selection as of the last select event — React resets the
  // caret to the end when the value changes, so restore from this.
  const lastSelRef = useRef({ start: 0, end: 0 });
  const segmentsRef = useRef(segments);
  // Where to put the caret after an edit we made: a word id, or the text end.
  const pendingCaretRef = useRef<number | "end" | null>(null);
  // Last word the caret seeked to, so repeated select events don't re-seek.
  const caretWordRef = useRef<number | null>(null);

  // Programmatic edits aren't announced by screen readers; say what happened.
  // The trailing space alternates so repeating a message still re-announces.
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((message: string) => {
    setAnnouncement((prev) => (prev === message ? `${message}\u00a0` : message));
  }, []);

  useLayoutEffect(() => {
    const prev = segmentsRef.current;
    segmentsRef.current = segments;
    const pending = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const el = ref.current;
    if (!el || prev === segments || document.activeElement !== el) return;

    let caret: number | null = null;
    if (pending === "end") caret = text.length;
    else if (pending !== null) caret = wordStartOffset(segments, pending);
    if (caret === null) {
      // Keep the caret on the same word (and offset in it) when it survived.
      const { start } = lastSelRef.current;
      const anchor = prev.find((seg) => start >= seg.start && start <= seg.end);
      const moved = anchor && segments.find((seg) => seg.id === anchor.id);
      if (moved) {
        caret = Math.min(moved.end, moved.start + start - anchor.start);
      } else {
        // The word was replaced (correct / undo) — fall back to the playhead.
        caret =
          wordStartOffset(segments, activeWordOf(useEditorStore.getState())) ??
          Math.min(start, text.length);
      }
    }
    el.setSelectionRange(caret, caret);
    lastSelRef.current = { start: caret, end: caret };
  }, [segments, text]);

  const handleSelect = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    lastSelRef.current = { start, end };
    const s = useEditorStore.getState();
    const ids = wordIdsInRange(segments, start, end);
    if (!sameIds(s.selectedWordIds, ids)) s.setSelectedWords(ids);
    const caretId = ids[0] ?? wordIdAtCaret(segments, start);
    if (caretId === null || caretId === caretWordRef.current) return;
    caretWordRef.current = caretId;
    const word = s.words.find((w) => w.id === caretId);
    if (word) seekToWord(word);
  }, [segments]);

  // Pick up where the playhead is, so play → pause → edit lands on the word
  // that was just heard.
  const handleFocus = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const activeId = activeWordOf(useEditorStore.getState());
    if (activeId === wordIdAtCaret(segments, el.selectionStart)) return;
    const at = wordStartOffset(segments, activeId);
    if (at === null) return;
    caretWordRef.current = activeId;
    el.setSelectionRange(at, at);
  }, [segments]);

  const cutAtCaret = useCallback(
    (direction: "backward" | "forward") => {
      const el = ref.current;
      if (!el) return;
      const { selectionStart: start, selectionEnd: end } = el;
      let ids = wordIdsInRange(segments, start, end);
      if (ids.length === 0) {
        const id = wordIdForDelete(segments, start, direction);
        ids = id === null ? [] : [id];
      }
      if (ids.length === 0) {
        announce(t("transcript.textNothingToCut"));
        return;
      }
      const lastIndex = segments.findIndex((seg) => seg.id === ids[ids.length - 1]);
      pendingCaretRef.current = segments[lastIndex + 1]?.id ?? "end";
      const s = useEditorStore.getState();
      const idSet = new Set(ids);
      const cutText = s.words
        .filter((w) => idSet.has(w.id))
        .map((w) => w.text)
        .join(" ");
      s.deleteWords(ids);
      s.setSelectedWords([]);
      announce(t("transcript.textCut", { text: cutText }));
    },
    [segments, announce, t]
  );

  const undo = useCallback(
    (redo: boolean) => {
      const s = useEditorStore.getState();
      if (redo) s.redo();
      else s.undo();
      announce(t(redo ? "transcript.textRedo" : "transcript.textUndo"));
    },
    [announce, t]
  );

  // Cut / Copy / Paste — from keys, the context menu or the app's Edit menu.
  // Cut deletes the words until they are pasted; a paste moves them to the
  // caret, and pasting copied words inserts a duplicate. The system clipboard
  // gets the plain text; a paste is refused when it holds other text — the
  // user copied something else since.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const selectedIds = () => wordIdsInRange(segments, el.selectionStart, el.selectionEnd);
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      e.preventDefault();
      const ids = selectedIds();
      if (ids.length === 0) return;
      const s = useEditorStore.getState();
      if (cut) {
        const lastIndex = segments.findIndex((seg) => seg.id === ids[ids.length - 1]);
        pendingCaretRef.current = segments[lastIndex + 1]?.id ?? "end";
      }
      const copied = cut ? s.cutWords(ids) : s.copyWords(ids);
      if (copied === null) return;
      e.clipboardData?.setData("text/plain", copied);
      announce(t(cut ? "transcript.textCut" : "transcript.textCopied", { text: copied }));
    };
    const handleCut = (e: ClipboardEvent) => onCopy(e, true);
    const handleCopy = (e: ClipboardEvent) => onCopy(e, false);
    const handlePaste = (e: ClipboardEvent) => {
      e.preventDefault();
      const s = useEditorStore.getState();
      const pasted = e.clipboardData?.getData("text/plain");
      if (!s.clipboard || (pasted && pasted !== s.clipboard.text)) {
        announce(t("transcript.textNothingToPaste"));
        return;
      }
      const beforeId = wordIdBeforeCaret(segments, el.selectionStart);
      const at = beforeId === null ? s.words.length : s.words.findIndex((w) => w.id === beforeId);
      if (at < 0 || !s.pasteWords(at)) return;
      pendingCaretRef.current = beforeId ?? "end";
      announce(t("transcript.textPasted", { text: s.clipboard.text }));
    };
    el.addEventListener("cut", handleCut);
    el.addEventListener("copy", handleCopy);
    el.addEventListener("paste", handlePaste);
    return () => {
      el.removeEventListener("cut", handleCut);
      el.removeEventListener("copy", handleCopy);
      el.removeEventListener("paste", handlePaste);
    };
  }, [segments, announce, t]);

  // Native beforeinput carries inputType (React's onBeforeInput doesn't), so
  // every other way of editing — keys, the Edit menu — is caught here. Nothing
  // reaches the value directly; deletions become word cuts.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: InputEvent) => {
      e.preventDefault();
      if (e.inputType === "historyUndo") undo(false);
      else if (e.inputType === "historyRedo") undo(true);
      else if (e.inputType.startsWith("delete")) {
        cutAtCaret(e.inputType.includes("Backward") ? "backward" : "forward");
      }
    };
    el.addEventListener("beforeinput", handler);
    return () => el.removeEventListener("beforeinput", handler);
  }, [cutAtCaret, undo]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const mod = e.metaKey || e.ctrlKey;
      // The editor's global shortcuts skip text fields, so mirror the ones
      // that make sense here.
      if (e.code === "Space" && !mod && !e.altKey) {
        e.preventDefault();
        useEditorStore.getState().togglePlayback();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo(e.shiftKey);
      } else if (e.key === "Enter" && !mod && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const el = e.currentTarget;
        let ids = wordIdsInRange(segments, el.selectionStart, el.selectionEnd);
        if (ids.length === 0) {
          const id = wordIdAtCaret(segments, el.selectionStart);
          ids = id === null ? [] : [id];
        }
        if (ids.length > 0) onCorrect(ids, el);
      }
    },
    [segments, undo, onCorrect]
  );

  return (
    <>
      <textarea
        ref={ref}
        data-transcript-text
        value={text}
        // Edits are intercepted in beforeinput; React restores the value if
        // anything (e.g. IME composition) slips through.
        onChange={() => {}}
        onSelect={handleSelect}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        aria-label={t("transcript.textLabel")}
        aria-describedby={hintId}
        // No wrapping: each speaker turn is one line for line navigation.
        wrap="off"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className="peer sr-only"
      />
      {/* The textarea is invisible; outline the transcript for sighted keyboard users. */}
      <div className="pointer-events-none absolute inset-0 z-20 hidden ring-2 ring-inset ring-zinc-400 peer-focus-visible:block dark:ring-zinc-500" />
      <p id={hintId} hidden>
        {t("transcript.textHint")}
      </p>
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </>
  );
}
