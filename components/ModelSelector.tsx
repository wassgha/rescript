"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Languages,
  Loader2,
} from "lucide-react";
import {
  SignalBarsHigh,
  SignalBarsLow,
  SignalBarsMedium,
} from "./SignalBars";
import {
  AUTO_TRANSCRIPT_LANGUAGE_INFO,
  TRANSCRIPT_LANGUAGE_PREFERENCE_ORDER,
  TRANSCRIPT_LANGUAGES,
  type TranscriptLanguagePreference,
} from "@/lib/languages";
import {
  MODEL_ORDER,
  MODELS,
  isModelId,
  isWhisperModel,
} from "@/lib/models";
import type { TranscriptSource } from "@/lib/source";
import {
  hydrateModelPreference,
  hydrateTranscriptLanguagePreference,
  useEditorStore,
} from "@/lib/store";
import Popover, { PopoverContent, PopoverTrigger } from "./Popover";
import { useI18n } from "./I18nProvider";

export type ModelOptionContextValue = {
  /** Currently selected source id. */
  value: TranscriptSource;
  selected: boolean;
  select: () => void;
  /** Close the dropdown after a normal selection. */
  closeMenu: () => void;
  /** Keep the menu open (file pickers, async status, …). */
  keepMenuOpen: () => void;
};

/** Any `size` + `className` icon: lucide's, or a local one like {@link SignalBarsLow}. */
export type IconComponent = ComponentType<{
  size?: number | string;
  className?: string;
}>;

export type OptionTrigger = {
  label: ReactNode;
  icon?: IconComponent;
  iconClassName?: string;
  /** Show a spinner instead of the icon in the closed trigger. */
  busy?: boolean;
};

type SelectorContextValue = {
  value: TranscriptSource;
  setValue: (id: TranscriptSource) => void;
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
  id: TranscriptSource,
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
 *
 * Use `embedded` to render only the option list inside another panel (Settings).
 */
export default function ModelSelector({
  children,
  groupLabel = "Speech model",
  embedded = false,
  onClose,
  onKeepOpen,
}: {
  children?: ReactNode;
  groupLabel?: string;
  /** Render the option list only — for nesting inside Settings. */
  embedded?: boolean;
  /** Called when an option wants to dismiss the parent panel (embedded). */
  onClose?: () => void;
  /** Called when an option needs the parent panel to stay open (embedded). */
  onKeepOpen?: () => void;
}) {
  const source = useEditorStore((s) => s.source);
  const setSource = useEditorStore((s) => s.setSource);
  const transcriptLanguage = useEditorStore((s) => s.transcriptLanguage);
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [triggers, setTriggers] = useState<Record<string, OptionTrigger>>({});
  const listId = useId();

  useEffect(() => {
    hydrateModelPreference();
    hydrateTranscriptLanguagePreference();
  }, []);

  const closeMenu = useCallback(() => {
    if (embedded) onClose?.();
    else setOpen(false);
  }, [embedded, onClose]);
  const keepMenuOpen = useCallback(() => {
    if (embedded) onKeepOpen?.();
    else setOpen(true);
  }, [embedded, onKeepOpen]);

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
      value: source,
      setValue: setSource,
      closeMenu,
      keepMenuOpen,
      registerTrigger,
      unregisterTrigger,
    }),
    [source, setSource, closeMenu, keepMenuOpen, registerTrigger, unregisterTrigger]
  );

  const activeTrigger = triggers[source];
  // Prefer the option's registered trigger. Fall back carefully so an unmounted
  // custom option (e.g. import) never shows the raw id + default wave icon.
  const TriggerIcon =
    activeTrigger?.icon ?? (source === "import" ? FileText : AudioLines);
  const baseTriggerLabel =
    activeTrigger?.label ??
    (isModelId(source)
      ? MODELS[source].label
      : source === "import"
        ? t("model.importTranscript")
        : String(source));
  const languageInfo =
    transcriptLanguage === "auto"
      ? AUTO_TRANSCRIPT_LANGUAGE_INFO
      : TRANSCRIPT_LANGUAGES[transcriptLanguage];
  const showLanguageInTrigger =
    isWhisperModel(source) &&
    !activeTrigger?.busy;

  // Always mount options (hidden when closed) so custom triggers stay registered.
  const options = children ?? (
    <>
      {MODEL_ORDER.map((id) => (
        <ModelOption key={id} id={id} />
      ))}
    </>
  );

  if (embedded) {
    return (
      <ModelSelectorCtx.Provider value={ctx}>
        <div>
          <p className="px-3 pb-1 pt-2.5 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
            {groupLabel}
          </p>
          <div className="space-y-1 p-1 pb-1.5">{options}</div>
        </div>
      </ModelSelectorCtx.Provider>
    );
  }

  return (
    <ModelSelectorCtx.Provider value={ctx}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        placement="bottom-end"
        backdrop
      >
        <div className="relative z-30 shrink-0">
          <PopoverTrigger>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-controls={listId}
              aria-label={
                showLanguageInTrigger
                  ? `${typeof baseTriggerLabel === "string" ? baseTriggerLabel : t("model.transcriptSource")}, ${languageInfo.label}`
                  : undefined
              }
              onClick={() => setOpen((v) => !v)}
              className="inline-flex max-w-[18rem] items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-800 cursor-pointer transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
            >
              {activeTrigger?.busy ? (
                <Loader2 size={14} className="shrink-0 animate-spin text-zinc-500" />
              ) : (
                <TriggerIcon
                  size={14}
                  className={`shrink-0 ${activeTrigger?.iconClassName ?? "text-zinc-500"}`}
                />
              )}
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                <span className="truncate">{baseTriggerLabel}</span>
                {showLanguageInTrigger && (
                  <>
                    <span
                      className="shrink-0 font-normal text-zinc-300 dark:text-zinc-600"
                      aria-hidden
                    >
                      |
                    </span>
                    <Languages
                      size={14}
                      className="shrink-0 text-zinc-500 dark:text-zinc-400"
                      aria-hidden
                    />
                    <span className="shrink-0 font-normal text-zinc-500 dark:text-zinc-400">
                      {languageInfo.code}
                    </span>
                  </>
                )}
              </span>
              <ChevronDown
                size={14}
                className={`shrink-0 text-zinc-400 transition dark:text-zinc-500 ${open ? "rotate-180" : ""}`}
              />
            </button>
          </PopoverTrigger>

          {/* Keep options mounted when closed so custom triggers stay registered. */}
          <PopoverContent
            id={listId}
            role="listbox"
            aria-label={groupLabel}
            className="z-40 w-[18rem] overflow-visible"
          >
            <p className="px-3 pb-1 pt-2.5 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              {groupLabel}
            </p>
            <div className="p-1 pb-1.5 space-y-1">{options}</div>
          </PopoverContent>
        </div>
      </Popover>
    </ModelSelectorCtx.Provider>
  );
}

/**
 * Signal bars stand in for relative model strength on the default rows.
 *
 * A plain lookup rather than a `iconForSource(id)` helper: the row renders this
 * value as JSX, and react-hooks/static-components reads any call result used as
 * a component type as a component created during render.
 */
const SOURCE_ICONS: Record<TranscriptSource, IconComponent> = {
  base: SignalBarsLow,
  small: SignalBarsMedium,
  parakeet: SignalBarsHigh,
  import: FileText,
};

/** Default option row: icon + label + optional meta. ASR ids fill in from MODELS. */
export function ModelOption({
  id,
  label,
  meta,
  icon,
  children,
  onSelect,
  /** When false, a child owns the closed trigger via `useOptionTrigger`. */
  autoTrigger = true,
}: {
  id: TranscriptSource;
  label?: string;
  meta?: string;
  icon?: IconComponent;
  children?: ReactNode;
  onSelect?: (ctx: ModelOptionContextValue) => void;
  autoTrigger?: boolean;
}) {
  const selector = useSelectorCtx();
  const selected = selector.value === id;

  const Icon = icon ?? SOURCE_ICONS[id];
  const resolvedLabel = label ?? (isModelId(id) ? MODELS[id].label : id);
  const resolvedMeta = meta ?? (isModelId(id) ? MODELS[id].size : undefined);

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
        className={`flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition cursor-pointer ${selected
            ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
            : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
          }`}
      >
        <span className="flex w-full items-center gap-2.5">
          <Icon
            size={15}
            className={selected ? "text-zinc-700 dark:text-zinc-200" : "text-zinc-400 dark:text-zinc-500"}
          />
          <span className="min-w-0 flex-1 text-[13px] font-medium leading-tight">
            {resolvedLabel}
          </span>
          {resolvedMeta && (
            <span className="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">{resolvedMeta}</span>
          )}
        </span>
        {children}
      </button>
    </OptionCtx.Provider>
  );
}

/** Separator between option groups (e.g. Whisper vs import). */
export function ModelOptionSeparator() {
  return <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" role="separator" />;
}

/** Language hint as a flyout submenu inside the model / transcript-source menu. */
export function LanguageSection() {
  const language = useEditorStore((s) => s.transcriptLanguage);
  const setLanguage = useEditorStore((s) => s.setTranscriptLanguage);
  const selector = useSelectorCtx();
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const submenuId = useId();
  const { t } = useI18n();
  const active =
    language === "auto"
      ? AUTO_TRANSCRIPT_LANGUAGE_INFO
      : TRANSCRIPT_LANGUAGES[language];

  const select = (next: TranscriptLanguagePreference) => {
    setLanguage(next);
    setSubmenuOpen(false);
    selector.closeMenu();
  };

  return (
    <div>
      <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
        {t("model.language")}
      </p>
      {/* No portal: stay in the parent panel DOM so outside-click on the model
          menu still treats this flyout as inside the floating tree. */}
      <Popover
        open={submenuOpen}
        onOpenChange={setSubmenuOpen}
        placement="right-start"
        offsetMain={6}
        portal={false}
        escapeStopPropagation
      >
        <div className="relative">
          <PopoverTrigger>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={submenuOpen}
              aria-controls={submenuId}
              onClick={() => {
                setSubmenuOpen((v) => !v);
                selector.keepMenuOpen();
              }}
              className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${submenuOpen
                  ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                  : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
                }`}
            >
              <span className="text-[15px] leading-none" aria-hidden>
                {active.flag}
              </span>
              <span className="min-w-0 flex-1 text-[13px] font-medium leading-tight">
                {language === "auto" ? t("common.auto") : active.nativeLabel}
              </span>
              <ChevronRight
                size={14}
                className={`shrink-0 text-zinc-400 transition dark:text-zinc-500 ${submenuOpen ? "rotate-180" : ""
                  }`}
              />
            </button>
          </PopoverTrigger>

          <PopoverContent
            id={submenuId}
            role="menu"
            aria-label={t("model.transcriptLanguage")}
            className="z-50 w-44 overflow-hidden p-1"
          >
            {TRANSCRIPT_LANGUAGE_PREFERENCE_ORDER.map((id) => {
              const option =
                id === "auto"
                  ? AUTO_TRANSCRIPT_LANGUAGE_INFO
                  : TRANSCRIPT_LANGUAGES[id];
              const selected = id === language;
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => select(id)}
                  className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${selected
                      ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                      : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
                    }`}
                >
                  <span className="text-[15px] leading-none" aria-hidden>
                    {option.flag}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] font-medium leading-tight">
                    {id === "auto" ? t("common.auto") : option.nativeLabel}
                  </span>
                  {selected && (
                    <Check
                      size={14}
                      className="shrink-0 text-zinc-500 dark:text-zinc-300"
                    />
                  )}
                </button>
              );
            })}
          </PopoverContent>
        </div>
      </Popover>
      {selector.value === "parakeet" && (
        <p className="px-2.5 pb-1 pt-1 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          {t("model.parakeetAuto")}
        </p>
      )}
    </div>
  );
}
