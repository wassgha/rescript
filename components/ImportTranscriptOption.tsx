"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import {
  isTranscriptFile,
  parseTranscriptFile,
  TRANSCRIPT_ACCEPT,
} from "@/lib/parseTranscript";
import { isSpeechAnalyzerModel, isWhisperModel } from "@/lib/models";
import { useEditorStore } from "@/lib/store";
import {
  ModelOption,
  useModelOption,
  useOptionTrigger,
  type ModelOptionContextValue,
} from "./ModelSelector";

/**
 * ModelSelector option that opens a caption file picker and surfaces parse
 * status / errors on the row (and in the closed trigger).
 *
 * The file input must NOT be nested inside the option <button> — that invalid
 * HTML makes some browsers stop delivering clicks to the selector after the
 * OS dialog is cancelled. Cancel also must not call closeMenu(): the menu is
 * already closed before the picker opens, and a delayed close would dismiss a
 * menu the user just reopened.
 */
export default function ImportTranscriptOption() {
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  const setPendingTranscript = useEditorStore((s) => s.setPendingTranscript);
  const setModel = useEditorStore((s) => s.setModel);
  const selected = useEditorStore((s) => s.model === "import");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<Pick<
    ModelOptionContextValue,
    "keepMenuOpen" | "closeMenu" | "select"
  > | null>(null);
  const previousModelRef = useRef<"base" | "small" | "speechanalyzer">("base");
  const pickGenRef = useRef(0);

  /** Reset import-pick state only — never touch the dropdown open state. */
  const finishCancel = useCallback(() => {
    setPicking(false);
    setReading(false);
    setError(null);
    if (!useEditorStore.getState().pendingTranscript) {
      setModel(previousModelRef.current);
    }
  }, [setModel]);

  // If the user switches to another transcript source while a picker/parse is in
  // flight, invalidate so a late onChange/parse cannot flip model back to import.
  useEffect(() => {
    return useEditorStore.subscribe((state, prev) => {
      const switchedAway =
        isWhisperModel(state.model) || isSpeechAnalyzerModel(state.model);
      if (!switchedAway || state.model === prev.model) return;
      pickGenRef.current += 1;
      queueMicrotask(() => {
        setPicking(false);
        setReading(false);
        setError(null);
      });
    });
  }, []);

  // Native file-input "cancel" (not in React's input prop types yet).
  useEffect(() => {
    const input = fileRef.current;
    if (!input) return;
    const onCancel = () => {
      pickGenRef.current += 1;
      finishCancel();
    };
    input.addEventListener("cancel", onCancel);
    return () => input.removeEventListener("cancel", onCancel);
  }, [finishCancel]);

  // Fallback when the OS dialog is cancelled without firing onChange/cancel.
  useEffect(() => {
    if (!picking) return;
    const gen = pickGenRef.current;
    const onFocus = () => {
      window.setTimeout(() => {
        if (pickGenRef.current !== gen) return;
        finishCancel();
      }, 400);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [picking, finishCancel]);

  const triggerLabel = reading
    ? "Import…"
    : error
      ? "Import failed"
      : pendingTranscript
        ? pendingTranscript.name
        : "Import transcript";

  // Keep the custom trigger registered whenever import owns (or is about to
  // own) the closed button — otherwise ModelSelector falls back to the raw id
  // "import" + AudioLines.
  const triggerEnabled =
    selected || picking || reading || Boolean(error) || Boolean(pendingTranscript);

  return (
    <>
    {/* Sibling of the option button — never nest <input> inside <button>. */}
    <input
        ref={fileRef}
        type="file"
        accept={TRANSCRIPT_ACCEPT}
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          const files = e.target.files;
          e.target.value = "";
          void (async () => {
            const file = files?.[0];
            const menu = menuRef.current;
            const gen = ++pickGenRef.current; // invalidate focus-cancel timer
            if (!file) {
              finishCancel();
              return;
            }
            if (!isTranscriptFile(file)) {
              setPicking(false);
              setError("Choose an SRT, VTT, or JSON file.");
              setPendingTranscript(null);
              setModel("import");
              menu?.keepMenuOpen();
              return;
            }
            setReading(true);
            setPicking(false);
            setError(null);
            setModel("import"); // so the closed trigger can show progress
            try {
              const words = await parseTranscriptFile(file);
              if (pickGenRef.current !== gen) return;
              setPendingTranscript({ name: file.name, words });
              setModel("import");
              menu?.closeMenu();
            } catch (err) {
              if (pickGenRef.current !== gen) return;
              console.error(err);
              setPendingTranscript(null);
              setError(
                err instanceof Error
                  ? err.message
                  : "Could not read that transcript."
              );
              setModel("import");
              menu?.keepMenuOpen();
            } finally {
              if (pickGenRef.current === gen) setReading(false);
            }
          })();
        }}
      />
      <ModelOption
        id="import"
        label="Import transcript"
        meta="SRT / VTT / JSON"
        icon={FileText}
        autoTrigger={false}
        onSelect={(ctx) => {
          menuRef.current = ctx;
          const current = useEditorStore.getState().model;
          if (isWhisperModel(current) || isSpeechAnalyzerModel(current)) {
            previousModelRef.current = current;
          }
          // Do not set model to "import" until a file is chosen. Close the menu
          // before the OS dialog so cancel cannot leave it pinned open.
          pickGenRef.current += 1;
          setPicking(true);
          setError(null);
          ctx.closeMenu();
          requestAnimationFrame(() => fileRef.current?.click());
        }}
      >
        <ImportTrigger
          label={triggerLabel}
          busy={reading}
          error={Boolean(error)}
          enabled={triggerEnabled}
        />
        <ImportStatus reading={reading} error={error} picking={picking} />
      </ModelOption>
    </>
  );
}

function ImportTrigger({
  label,
  busy,
  error,
  enabled,
}: {
  label: string;
  busy: boolean;
  error: boolean;
  enabled: boolean;
}) {
  useOptionTrigger(
    "import",
    {
      label,
      icon: FileText,
      iconClassName: error ? "text-red-500" : "text-zinc-500",
      busy,
    },
    enabled
  );
  return null;
}

function ImportStatus({
  reading,
  error,
  picking,
}: {
  reading: boolean;
  error: string | null;
  picking: boolean;
}) {
  const { selected } = useModelOption();
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  if (!picking && !selected && !reading && !error) return null;
  if (!reading && !pendingTranscript && !error && !picking) return null;
  return (
    <span
      className={`pl-[1.625rem] text-[11px] leading-snug ${
        error ? "text-red-500" : "text-zinc-500"
      }`}
    >
      {reading ? (
        <span className="inline-flex items-center gap-1">
          <Loader2 size={11} className="animate-spin" />
          Reading file…
        </span>
      ) : error ? (
        error
      ) : pendingTranscript ? (
        `${pendingTranscript.name} · ${pendingTranscript.words.length} words`
      ) : picking ? (
        "Choose an SRT, VTT, or JSON file…"
      ) : null}
    </span>
  );
}
