"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FileUp, X } from "lucide-react";
import {
  isTranscriptFile,
  parseTranscript,
  parseTranscriptFile,
  TRANSCRIPT_ACCEPT,
  type ParsedTranscript,
} from "@/lib/parseTranscript";

/**
 * Descript-style paste / file dialog for bringing your own transcript.
 * Callers receive a parsed timed or untimed transcript plus a display name.
 */
export default function PasteTranscriptDialog({
  open,
  title = "Import transcript",
  submitLabel = "Use transcript",
  onClose,
  onParsed,
}: {
  open: boolean;
  title?: string;
  /** Primary button when the textarea has text (e.g. "Sync transcript"). */
  submitLabel?: string;
  onClose: () => void;
  /** Return `false` to keep the dialog open (e.g. user dismissed a confirm). */
  onParsed: (
    parsed: ParsedTranscript,
    name: string
  ) => void | boolean | Promise<void | boolean>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => areaRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const applyParsed = useCallback(
    async (parsed: ParsedTranscript, name: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await onParsed(parsed, name);
        if (result === false) return;
        onClose();
      } catch (err) {
        console.error(err);
        setError(
          err instanceof Error ? err.message : "Could not use that transcript."
        );
      } finally {
        setBusy(false);
      }
    },
    [onParsed, onClose]
  );

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Paste a transcript, or choose a file.");
      return;
    }
    try {
      // Empty filename → sniff timed formats, else treat as plain text to sync.
      const parsed = parseTranscript(trimmed, "");
      const name =
        parsed.kind === "untimed" ? "Pasted transcript" : "Pasted captions";
      void applyParsed(parsed, name);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not read that transcript."
      );
    }
  }, [text, applyParsed]);

  const handleFile = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      if (!isTranscriptFile(file)) {
        setError("Choose an SRT, VTT, JSON, or TXT file.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const parsed = await parseTranscriptFile(file);
        await applyParsed(parsed, file.name);
      } catch (err) {
        console.error(err);
        setError(
          err instanceof Error ? err.message : "Could not read that transcript."
        );
        setBusy(false);
      }
    },
    [applyParsed]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 id={titleId} className="text-[15px] font-semibold text-zinc-900">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="mb-3 text-[13px] leading-relaxed text-zinc-500">
            Paste a plain-text script to sync with your media, or drop in timed
            captions (SRT / VTT / JSON). Optional speaker labels:{" "}
            <span className="font-medium text-zinc-600">Name: dialogue</span>
          </p>
          <textarea
            ref={areaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            disabled={busy}
            rows={10}
            placeholder={`Alice: Hello there.\nBob: Hi — how are you?`}
            className="w-full resize-y rounded-xl border border-zinc-200 bg-zinc-50/80 px-3 py-2.5 text-[13px] leading-relaxed text-zinc-800 placeholder:text-zinc-400 outline-none transition focus:border-zinc-400 focus:bg-white focus:ring-2 focus:ring-zinc-900/5 disabled:opacity-60"
          />
          {error && (
            <p className="mt-2 text-[12px] text-red-500" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 px-5 py-3.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40"
          >
            <FileUp size={14} />
            Choose file…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={TRANSCRIPT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              e.target.value = "";
              void handleFile(files);
            }}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={handleSubmit}
              className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-[13px] font-medium text-white transition hover:bg-zinc-800 disabled:opacity-40"
            >
              {busy ? "Working…" : submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
