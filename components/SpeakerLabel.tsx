"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  Check,
  ChevronDown,
  GripVertical,
  MoreHorizontal,
  Plus,
  Replace,
  Trash2,
  UserRoundPen,
} from "lucide-react";
import { FloatingPortal } from "@floating-ui/react";
import { useEditorStore } from "@/lib/store";
import {
  findSpeakerByName,
  speakerColor,
  speakerLabel,
} from "@/lib/speakers";
import type { SpeakerInfo } from "@/lib/types";
import { useWordAnchorFloating } from "@/hooks/useWordAnchorFloating";
import Popover, { PopoverContent, PopoverTrigger } from "./Popover";
import { useI18n } from "./I18nProvider";
import type { Translate } from "@/lib/i18n";

type PickerMode = "change" | "rename" | "replace";

function localizedSpeakerName(name: string, t: Translate): string {
  const match = /^Speaker (\d+)$/.exec(name);
  return match ? t("speaker.defaultName", { number: match[1] }) : name;
}

/**
 * Speaker heading: rename / change / replace / remove, plus a grip to drag
 * the turn boundary onto another word in the adjacent turns.
 */
export default function SpeakerLabel({
  speakerId,
  turnWordIds,
  turnStartWordId,
  canMove,
}: {
  speakerId: number;
  /** All word ids in this speaker turn (for Change speaker). */
  turnWordIds: number[];
  turnStartWordId: number;
  /** False for the first turn — nothing to merge a boundary against. */
  canMove: boolean;
}) {
  const { t } = useI18n();
  const speakers = useEditorStore((s) => s.speakers);
  const changeTurnSpeaker = useEditorStore((s) => s.changeTurnSpeaker);
  const renameSpeaker = useEditorStore((s) => s.renameSpeaker);
  const replaceSpeakerInProject = useEditorStore((s) => s.replaceSpeakerInProject);
  const removeSpeakerFromProject = useEditorStore(
    (s) => s.removeSpeakerFromProject
  );
  const moveSpeakerLabel = useEditorStore((s) => s.moveSpeakerLabel);

  const label = speakerLabel(speakers, speakerId);
  const displayLabel = localizedSpeakerName(label, t);
  const color = speakerColor(speakerId);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<PickerMode>("change");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const panelId = useId();

  const openPicker = useCallback((next: PickerMode) => {
    setMode(next);
    setQuery(next === "rename" ? label : "");
    setMenuOpen(false);
    setPickerOpen(true);
  }, [label]);

  useEffect(() => {
    if (!pickerOpen) return;
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      if (mode === "rename") inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [pickerOpen, mode]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return speakers;
    return speakers.filter((s) => s.name.toLowerCase().includes(q));
  }, [speakers, query]);

  const exact = findSpeakerByName(speakers, query);
  const trimmedQuery = query.trim();
  const canCreate =
    mode !== "replace" &&
    trimmedQuery.length > 0 &&
    !exact;
  const canRenameTo =
    mode !== "replace" &&
    trimmedQuery.length > 0 &&
    trimmedQuery.toLowerCase() !== label.toLowerCase();

  const applySpeaker = useCallback(
    (target: number | "new", name?: string) => {
      if (mode === "replace") {
        if (target === "new" || target === speakerId) return;
        replaceSpeakerInProject(speakerId, target);
      } else if (mode === "rename") {
        const nextName = (name ?? trimmedQuery).trim();
        if (!nextName) return;
        // Typing an existing name merges this label into that speaker.
        const existing = findSpeakerByName(speakers, nextName);
        if (existing && existing.id !== speakerId) {
          replaceSpeakerInProject(speakerId, existing.id);
        } else {
          renameSpeaker(speakerId, nextName);
        }
      } else {
        changeTurnSpeaker(turnWordIds, target, name);
      }
      setPickerOpen(false);
      setQuery("");
    },
    [
      mode,
      speakerId,
      trimmedQuery,
      speakers,
      turnWordIds,
      changeTurnSpeaker,
      renameSpeaker,
      replaceSpeakerInProject,
    ]
  );

  const onSubmit = useCallback(() => {
    if (!trimmedQuery) return;
    if (mode === "rename") {
      applySpeaker(speakerId, trimmedQuery);
      return;
    }
    if (exact) {
      applySpeaker(exact.id);
      return;
    }
    if (mode === "replace") return;
    applySpeaker("new", trimmedQuery);
  }, [trimmedQuery, mode, exact, applySpeaker, speakerId]);

  // --- Drag to move turn boundary ---
  const draggingRef = useRef(false);
  const [dragOverWordId, setDragOverWordId] = useState<number | null>(null);

  const clearDrag = useCallback(() => {
    draggingRef.current = false;
    setDragOverWordId(null);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, []);

  const onGripPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!canMove) return;
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const span = el?.closest?.("[data-wid]") as HTMLElement | null;
        const wid = span ? Number(span.dataset.wid) : NaN;
        setDragOverWordId(Number.isFinite(wid) ? wid : null);
      };
      const onUp = (ev: PointerEvent) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const span = el?.closest?.("[data-wid]") as HTMLElement | null;
        const wid = span ? Number(span.dataset.wid) : NaN;
        clearDrag();
        if (Number.isFinite(wid)) {
          moveSpeakerLabel(turnStartWordId, wid);
        }
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [canMove, clearDrag, moveSpeakerLabel, turnStartWordId]
  );

  // Highlight the word under the drag cursor.
  useEffect(() => {
    if (dragOverWordId == null) return;
    const el = document.querySelector(
      `[data-wid="${dragOverWordId}"]`
    ) as HTMLElement | null;
    if (!el) return;
    const prev = el.style.boxShadow;
    el.style.boxShadow = `inset 3px 0 0 ${color}`;
    return () => {
      el.style.boxShadow = prev;
    };
  }, [dragOverWordId, color]);

  const title =
    mode === "rename"
      ? t("speaker.rename")
      : mode === "replace"
        ? t("speaker.replace")
        : t("speaker.change");

  return (
    <div className="mb-1.5 flex items-center gap-0.5">
      {canMove && (
        <button
          type="button"
          title={t("speaker.moveStart")}
          aria-label={t("speaker.moveLabel")}
          onPointerDown={onGripPointerDown}
          className="flex h-6 w-5 cursor-grab items-center justify-center rounded text-zinc-300 transition hover:bg-zinc-100 hover:text-zinc-500 active:cursor-grabbing dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <GripVertical size={13} />
        </button>
      )}

      <Popover open={pickerOpen} onOpenChange={setPickerOpen} placement="bottom-start">
        <div className="relative">
          <PopoverTrigger>
            <button
              type="button"
              onClick={() => openPicker("change")}
              className="group flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[13px] font-semibold transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
              style={{ color }}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              aria-controls={panelId}
            >
              {displayLabel}
              <ChevronDown
                size={12}
                className="opacity-50 transition group-hover:opacity-80"
              />
            </button>
          </PopoverTrigger>

          <PopoverContent
            id={panelId}
            role="dialog"
            aria-label={title}
            className="z-40 w-64 overflow-hidden p-0"
          >
            <div className="border-b border-zinc-100 px-2.5 py-2 dark:border-zinc-800">
              <p className="mb-1.5 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
                {title}
              </p>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onSubmit();
                  }
                }}
                placeholder={
                  mode === "rename"
                    ? t("speaker.newName")
                    : mode === "replace"
                      ? t("speaker.find")
                      : t("speaker.search")
                }
                className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-[13px] text-zinc-800 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500"
              />
            </div>

            <div className="max-h-56 overflow-y-auto py-1">
              {mode !== "replace" && canRenameTo && (
                <button
                  type="button"
                  onClick={() => applySpeaker(speakerId, trimmedQuery)}
                  className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-zinc-700 transition hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800/80"
                >
                  <UserRoundPen size={13} className="shrink-0 text-zinc-400" />
                  <span>
                    {t("speaker.renameTo", {
                      current: displayLabel,
                      next: trimmedQuery,
                    })}
                  </span>
                </button>
              )}
              {canCreate && (
                <button
                  type="button"
                  onClick={() => applySpeaker("new", trimmedQuery)}
                  className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-zinc-700 transition hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800/80"
                >
                  <Plus size={13} className="shrink-0 text-zinc-400" />
                  <span>
                    {t("speaker.create", { name: trimmedQuery })}
                  </span>
                </button>
              )}
              {filtered.length === 0 && !canCreate && !canRenameTo && (
                <p className="px-2.5 py-2 text-[12px] text-zinc-400">
                  {t("speaker.noMatches")}
                </p>
              )}
              {filtered.map((s) => (
                <SpeakerOption
                  key={s.id}
                  speaker={s}
                  active={s.id === speakerId && mode !== "replace"}
                  disabled={mode === "replace" && s.id === speakerId}
                  onSelect={() => applySpeaker(s.id)}
                />
              ))}
            </div>
          </PopoverContent>
        </div>
      </Popover>

      <Popover open={menuOpen} onOpenChange={setMenuOpen} placement="bottom-start">
        <div className="relative">
          <PopoverTrigger>
            <button
              type="button"
              title={t("speaker.options")}
              aria-label={t("speaker.options")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <MoreHorizontal size={14} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            role="menu"
            aria-label={t("speaker.options")}
            className="z-40 w-56 overflow-hidden py-1"
          >
            <MenuItem
              icon={UserRoundPen}
              label={t("speaker.renameAction")}
              onClick={() => openPicker("rename")}
            />
            <MenuItem
              icon={Replace}
              label={t("speaker.replace")}
              disabled={speakers.length < 2}
              onClick={() => openPicker("replace")}
            />
            <MenuItem
              icon={Trash2}
              label={t("speaker.removeProject")}
              disabled={speakers.length < 2}
              danger
              onClick={() => {
                setMenuOpen(false);
                removeSpeakerFromProject(speakerId);
              }}
            />
          </PopoverContent>
        </div>
      </Popover>
    </div>
  );
}

/** Toolbar button that opens the selection speaker picker. */
export function SelectionSpeakerButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-speaker-toolbar
      onClick={onClick}
      className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
    >
      <UserRoundPen size={13} />
      {t("speaker.button")}
    </button>
  );
}

/** Anchored picker for reassigning the current word selection. */
export function SelectionSpeakerPopover({
  wordIds,
  containerRef,
  onClose,
}: {
  wordIds: number[];
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const speakers = useEditorStore((s) => s.speakers);
  const words = useEditorStore((s) => s.words);
  const changeTurnSpeaker = useEditorStore((s) => s.changeTurnSpeaker);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { setFloating, floatingStyles } = useWordAnchorFloating({
    open: true,
    wordIds,
    containerRef,
    placement: "top",
    offsetMain: 8,
  });

  const currentSpeaker = useMemo(() => {
    const idSet = new Set(wordIds);
    const selected = words.filter((w) => idSet.has(w.id));
    if (selected.length === 0) return 0;
    return selected[0].speaker;
  }, [wordIds, words]);

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return speakers;
    return speakers.filter((s) => s.name.toLowerCase().includes(q));
  }, [speakers, query]);

  const exact = findSpeakerByName(speakers, query);
  const trimmedQuery = query.trim();
  const canCreate = trimmedQuery.length > 0 && !exact;

  const apply = useCallback(
    (target: number | "new", name?: string) => {
      changeTurnSpeaker(wordIds, target, name);
      onClose();
    },
    [changeTurnSpeaker, wordIds, onClose]
  );

  return (
    <FloatingPortal>
      <div
        ref={(node: HTMLDivElement | null) => {
          panelRef.current = node;
          setFloating(node);
        }}
        data-speaker-toolbar
        className="z-40 w-60 max-w-[calc(100vw-16px)] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-800 dark:shadow-black/40"
        style={floatingStyles}
        role="dialog"
        aria-label={t("speaker.change")}
      >
        <div className="border-b border-zinc-100 px-2.5 py-2 dark:border-zinc-700">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (exact) apply(exact.id);
              else if (canCreate) apply("new", trimmedQuery);
            }}
            placeholder={t("speaker.search")}
            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-[13px] text-zinc-800 outline-none focus:border-zinc-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:bg-zinc-900 dark:focus:border-zinc-400"
          />
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {canCreate && (
            <button
              type="button"
              onClick={() => apply("new", trimmedQuery)}
              className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-zinc-700 transition hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800/80"
            >
              <Plus size={13} className="shrink-0 text-zinc-400" />
              <span>
                {t("speaker.create", { name: trimmedQuery })}
              </span>
            </button>
          )}
          {filtered.map((s) => (
            <SpeakerOption
              key={s.id}
              speaker={s}
              active={s.id === currentSpeaker}
              onSelect={() => apply(s.id)}
            />
          ))}
        </div>
      </div>
    </FloatingPortal>
  );
}

function SpeakerOption({
  speaker,
  active,
  disabled,
  onSelect,
}: {
  speaker: SpeakerInfo;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-default disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800/80"
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: speakerColor(speaker.id) }}
      />
      <span className="flex-1 truncate font-medium">{localizedSpeakerName(speaker.name, t)}</span>
      {active && <Check size={13} className="shrink-0 text-zinc-400" />}
    </button>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: typeof Trash2;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[13px] transition disabled:cursor-default disabled:opacity-40 ${
        danger
          ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800/80"
      }`}
    >
      <Icon size={13} className="shrink-0 opacity-70" />
      {label}
    </button>
  );
}
