"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import {
  isTranscriptFile,
  parseTranscriptFile,
  TRANSCRIPT_ACCEPT,
} from "@/lib/parseTranscript";
import { isModelId, type ModelId } from "@/lib/models";
import { useEditorStore } from "@/lib/store";
import {
  ModelOption,
  useModelOption,
  useOptionTrigger,
  type ModelOptionContextValue,
} from "./ModelSelector";
import { useI18n } from "./I18nProvider";
import { localizeRuntimeMessage } from "@/lib/i18n";

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
  const { t } = useI18n();
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  const setPendingTranscript = useEditorStore((s) => s.setPendingTranscript);
  const setSource = useEditorStore((s) => s.setSource);
  const selected = useEditorStore((s) => s.source === "import");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<Pick<
    ModelOptionContextValue,
    "keepMenuOpen" | "closeMenu" | "select"
  > | null>(null);
  const previousModelRef = useRef<ModelId>("base");
  const pickGenRef = useRef(0);

  /** Reset import-pick state only — never touch the dropdown open state. */
  const finishCancel = useCallback(() => {
    setPicking(false);
    setReading(false);
    setError(null);
    if (!useEditorStore.getState().pendingTranscript) {
      setSource(previousModelRef.current);
    }
  }, [setSource]);

  // If the user switches to a speech model while a picker/parse is in flight,
  // invalidate so a late onChange/parse cannot flip source back to import.
  useEffect(() => {
    return useEditorStore.subscribe((state, prev) => {
      if (!isModelId(state.source) || state.source === prev.source) return;
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
    ? t("import.importing")
    : error
      ? t("import.failed")
      : pendingTranscript
        ? pendingTranscript.name
        : t("model.importTranscript");

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
              setError(t("transcript.invalidFile"));
              setPendingTranscript(null);
              setSource("import");
              menu?.keepMenuOpen();
              return;
            }
            setReading(true);
            setPicking(false);
            setError(null);
            setSource("import"); // so the closed trigger can show progress
            try {
              const parsed = await parseTranscriptFile(file);
              if (pickGenRef.current !== gen) return;
              setPendingTranscript({
                name: file.name,
                words: parsed.words,
                speakers: parsed.speakers,
              });
              setSource("import");
              menu?.closeMenu();
            } catch (err) {
              if (pickGenRef.current !== gen) return;
              console.error(err);
              setPendingTranscript(null);
              setError(
                err instanceof Error
                  ? localizeRuntimeMessage(err.message, t)
                  : t("error.readTranscript")
              );
              setSource("import");
              menu?.keepMenuOpen();
            } finally {
              if (pickGenRef.current === gen) setReading(false);
            }
          })();
        }}
      />
      <ModelOption
        id="import"
        label={t("model.importTranscript")}
        meta="SRT / VTT / JSON"
        icon={FileText}
        autoTrigger={false}
        onSelect={(ctx) => {
          menuRef.current = ctx;
          const current = useEditorStore.getState().source;
          if (isModelId(current)) {
            previousModelRef.current = current;
          }
          // Do not set source to "import" until a file is chosen. Close the menu
          // before the OS dialog so cancel cannot leave it pinned open.
          // Open the picker in this same user-gesture turn — deferring to rAF
          // drops Chrome's user activation and the dialog never appears.
          pickGenRef.current += 1;
          setPicking(true);
          setError(null);
          const input = fileRef.current;
          ctx.closeMenu();
          input?.click();
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
      icon: busy ? Loader2 : FileText,
      iconClassName: busy
        ? "animate-spin text-zinc-500"
        : error
          ? "text-red-500"
          : "text-zinc-500",
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
  const { t } = useI18n();
  if (reading) {
    return (
      <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        {t("import.readingFile")}
      </p>
    );
  }
  if (error) {
    return (
      <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{localizeRuntimeMessage(error, t)}</p>
    );
  }
  if (picking && !selected) {
    return (
      <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        {t("import.chooseFileShort")}
      </p>
    );
  }
  return null;
}
