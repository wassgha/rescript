"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AudioLines,
  ChevronDown,
  FileText,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import {
  MODELS,
  SPEECH_ANALYZER_INFO,
  isSpeechAnalyzerModel,
  isWhisperModel,
  type ModelChoice,
} from "@/lib/models";
import { hydrateModelPreference, useEditorStore } from "@/lib/store";

export type ModelOptionContextValue = {
  /** Currently selected source id. */
  value: ModelChoice;
  selected: boolean;
  select: () => void;
  /** Close the dropdown after a normal selection. */
  closeMenu: () => void;
  /** Keep the menu open (file pickers, async status, …). */
  keepMenuOpen: () => void;
};

export type OptionTrigger = {
  label: ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  /** Show a spinner instead of the icon in the closed trigger. */
  busy?: boolean;
};

type SelectorContextValue = {
  value: ModelChoice;
  setValue: (id: ModelChoice) => void;
  closeMenu: () => void;
  keepMenuOpen: () => void;
  registerTrigger: (id: string, trigger: OptionTrigger) => void;
  unregisterTrigger: (id: string) => void;
};

const ModelSelectorCtx = createContext<SelectorContextValue | null>(null);
const OptionCtx = createContext<ModelOptionContextValue | null>(null);

function useSelectorCtx(): SelectorContextValue {
  const ctx = useContext(ModelSelectorCtx);
  if (!ctx) {
    throw new Error("Model option components must be used inside ModelSelector");
  }
  return ctx;
}

export function useModelOption(): ModelOptionContextValue {
  const ctx = useContext(OptionCtx);
  if (!ctx) {
    throw new Error("useModelOption must be used inside a ModelSelector option");
  }
  return ctx;
}

/** Let a custom option drive the closed trigger while it is selected. */
export function useOptionTrigger(
  id: ModelChoice,
  trigger: OptionTrigger,
  enabled = true
) {
  const selector = useSelectorCtx();
  const { label, icon, iconClassName, busy } = trigger;
  useEffect(() => {
    if (!enabled) return;
    selector.registerTrigger(id, { label, icon, iconClassName, busy });
    return () => selector.unregisterTrigger(id);
  }, [selector, id, label, icon, iconClassName, busy, enabled]);
}

/**
 * Generic source / model dropdown. Pass option components as children
 * (`ModelOption`, or a custom option like `ImportTranscriptOption`).
 * With no children, renders the default Whisper Base / Small rows.
 *
 * Options stay mounted (hidden when closed) so custom triggers remain registered.
 */
export default function ModelSelector({
  children,
  groupLabel = "Speech model",
}: {
  children?: ReactNode;
  groupLabel?: string;
}) {
  const model = useEditorStore((s) => s.model);
  const setModel = useEditorStore((s) => s.setModel);
  const [open, setOpen] = useState(false);
  const [triggers, setTriggers] = useState<Record<string, OptionTrigger>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    hydrateModelPreference();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const closeMenu = useCallback(() => setOpen(false), []);
  const keepMenuOpen = useCallback(() => setOpen(true), []);

  const registerTrigger = useCallback((id: string, trigger: OptionTrigger) => {
    setTriggers((prev) => {
      const cur = prev[id];
      if (
        cur &&
        cur.label === trigger.label &&
        cur.icon === trigger.icon &&
        cur.iconClassName === trigger.iconClassName &&
        cur.busy === trigger.busy
      ) {
        return prev;
      }
      return { ...prev, [id]: trigger };
    });
  }, []);

  const unregisterTrigger = useCallback((id: string) => {
    setTriggers((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const ctx = useMemo(
    () => ({
      value: model,
      setValue: setModel,
      closeMenu,
      keepMenuOpen,
      registerTrigger,
      unregisterTrigger,
    }),
    [model, setModel, closeMenu, keepMenuOpen, registerTrigger, unregisterTrigger]
  );

  const activeTrigger = triggers[model];
  // Prefer the option's registered trigger. Fall back carefully so an unmounted
  // custom option (e.g. import) never shows the raw id + default wave icon.
  // SpeechAnalyzer shares the waveform icon with Whisper — both are "the app
  // transcribes for you", as opposed to a user-supplied caption file.
  const TriggerIcon =
    activeTrigger?.icon ?? (model === "import" ? FileText : AudioLines);
  const triggerLabel =
    activeTrigger?.label ??
    (isWhisperModel(model)
      ? MODELS[model].label
      : model === "import"
        ? "Import transcript"
        : isSpeechAnalyzerModel(model)
          ? SPEECH_ANALYZER_INFO.label
          : String(model));

  // Always mount options (hidden when closed) so custom triggers stay registered.
  const options = children ?? (
    <>
      <ModelOption id="base" />
      <ModelOption id="small" />
    </>
  );

  return (
    <ModelSelectorCtx.Provider value={ctx}>
      <div ref={rootRef} className="relative shrink-0">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex max-w-[14rem] items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-800 cursor-pointer transition hover:border-zinc-300 hover:bg-zinc-50"
        >
          {activeTrigger?.busy ? (
            <Loader2 size={14} className="shrink-0 animate-spin text-zinc-500" />
          ) : (
            <TriggerIcon
              size={14}
              className={`shrink-0 ${activeTrigger?.iconClassName ?? "text-zinc-500"}`}
            />
          )}
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown
            size={14}
            className={`shrink-0 text-zinc-400 transition ${open ? "rotate-180" : ""}`}
          />
        </button>

        <div
          id={listId}
          role="listbox"
          aria-label={groupLabel}
          hidden={!open}
          // Force display:none when closed so a lingering panel cannot eat clicks
          // (HTML [hidden] can be overridden by author CSS in some setups).
          className={`absolute right-0 top-[calc(100%+0.5rem)] z-20 w-[18rem] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-zinc-900/5 ${
            open ? "" : "pointer-events-none"
          }`}
          style={open ? undefined : { display: "none" }}
        >
          <p className="px-3 pb-1 pt-2.5 text-[11px] font-medium tracking-wide text-zinc-400">
            {groupLabel}
          </p>
          <div className="p-1 pb-1.5 space-y-1">{options}</div>
        </div>
      </div>
    </ModelSelectorCtx.Provider>
  );
}

/** Default option row: icon + label + optional meta. Whisper ids fill in from MODELS. */
export function ModelOption({
  id,
  label,
  meta,
  icon: Icon = AudioLines,
  children,
  onSelect,
  /** When false, a child owns the closed trigger via `useOptionTrigger`. */
  autoTrigger = true,
}: {
  id: ModelChoice;
  label?: string;
  meta?: string;
  icon?: LucideIcon;
  children?: ReactNode;
  onSelect?: (ctx: ModelOptionContextValue) => void;
  autoTrigger?: boolean;
}) {
  const selector = useSelectorCtx();
  const selected = selector.value === id;

  const resolvedLabel =
    label ??
    (isWhisperModel(id)
      ? MODELS[id].label
      : isSpeechAnalyzerModel(id)
        ? SPEECH_ANALYZER_INFO.label
        : id);
  const resolvedMeta =
    meta ??
    (isWhisperModel(id)
      ? MODELS[id].size
      : isSpeechAnalyzerModel(id)
        ? SPEECH_ANALYZER_INFO.size
        : undefined);

  const optionCtx = useMemo<ModelOptionContextValue>(
    () => ({
      value: selector.value,
      selected,
      select: () => selector.setValue(id),
      closeMenu: selector.closeMenu,
      keepMenuOpen: selector.keepMenuOpen,
    }),
    [selector, selected, id]
  );

  useOptionTrigger(id, { label: resolvedLabel, icon: Icon }, autoTrigger);

  const handleClick = () => {
    if (onSelect) {
      onSelect(optionCtx);
      return;
    }
    optionCtx.select();
    optionCtx.closeMenu();
  };

  return (
    <OptionCtx.Provider value={optionCtx}>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={handleClick}
        className={`flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition cursor-pointer ${
          selected
            ? "bg-zinc-100 text-zinc-900"
            : "text-zinc-700 hover:bg-zinc-50"
        }`}
      >
        <span className="flex w-full items-center gap-2.5">
          <Icon
            size={15}
            className={selected ? "text-zinc-700" : "text-zinc-400"}
          />
          <span className="min-w-0 flex-1 text-[13px] font-medium leading-tight">
            {resolvedLabel}
          </span>
          {resolvedMeta && (
            <span className="shrink-0 text-[11px] text-zinc-400">{resolvedMeta}</span>
          )}
        </span>
        {children}
      </button>
    </OptionCtx.Provider>
  );
}

/** Separator between option groups (e.g. Whisper vs import). */
export function ModelOptionSeparator() {
  return <div className="my-1 border-t border-zinc-100" role="separator" />;
}
