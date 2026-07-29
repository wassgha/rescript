"use client";

import { useCallback, useState } from "react";
import { FileText } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import type { ParsedTranscript } from "@/lib/parseTranscript";
import {
  ModelOption,
  useModelOption,
  useOptionTrigger,
} from "./ModelSelector";
import PasteTranscriptDialog from "./PasteTranscriptDialog";

/**
 * ModelSelector option that opens a paste / file dialog for the user's own
 * transcript (timed captions or plain text to sync).
 */
export default function ImportTranscriptOption() {
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  const setPendingTranscript = useEditorStore((s) => s.setPendingTranscript);
  const setModel = useEditorStore((s) => s.setModel);
  const selected = useEditorStore((s) => s.model === "import");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const triggerLabel = error
    ? "Import failed"
    : pendingTranscript
      ? pendingTranscript.name
      : "Import transcript";

  const triggerEnabled =
    selected || Boolean(error) || Boolean(pendingTranscript);

  const handleParsed = useCallback(
    (parsed: ParsedTranscript, name: string) => {
      setError(null);
      if (parsed.kind === "timed") {
        setPendingTranscript({ name, kind: "timed", words: parsed.words });
      } else {
        setPendingTranscript({ name, kind: "untimed", tokens: parsed.tokens });
      }
      setModel("import");
    },
    [setPendingTranscript, setModel]
  );

  return (
    <>
      <ModelOption
        id="import"
        label="Import transcript"
        meta="Paste or file"
        icon={FileText}
        autoTrigger={false}
        onSelect={(ctx) => {
          setError(null);
          ctx.closeMenu();
          setDialogOpen(true);
        }}
      >
        <ImportTrigger
          label={triggerLabel}
          error={Boolean(error)}
          enabled={triggerEnabled}
        />
        <ImportStatus error={error} />
      </ModelOption>
      {dialogOpen && (
        <PasteTranscriptDialog
          open
          title="Import transcript"
          submitLabel="Use transcript"
          onClose={() => setDialogOpen(false)}
          onParsed={handleParsed}
        />
      )}
    </>
  );
}

function ImportTrigger({
  label,
  error,
  enabled,
}: {
  label: string;
  error: boolean;
  enabled: boolean;
}) {
  useOptionTrigger(
    "import",
    {
      label,
      icon: FileText,
      iconClassName: error ? "text-red-500" : "text-zinc-500",
    },
    enabled
  );
  return null;
}

function ImportStatus({ error }: { error: string | null }) {
  const { selected } = useModelOption();
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  if (!selected && !error) return null;
  if (!pendingTranscript && !error) return null;
  return (
    <span
      className={`pl-[1.625rem] text-[11px] leading-snug ${
        error ? "text-red-500" : "text-zinc-500"
      }`}
    >
      {error
        ? error
        : pendingTranscript
          ? pendingTranscript.kind === "timed"
            ? `${pendingTranscript.name} · ${pendingTranscript.words.length} words`
            : `${pendingTranscript.name} · ${pendingTranscript.tokens.length} words · syncs to audio`
          : null}
    </span>
  );
}
