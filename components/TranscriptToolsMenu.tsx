"use client";

import { useId, useMemo, useState } from "react";
import { Undo2, VolumeX, WandSparkles, Zap, type LucideIcon } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { findDeletedFillerWordIds, findFillerWordIds } from "@/lib/fillers";
import {
  findSilenceCuts,
  findSilenceRanges,
  MIN_SILENCE_DURATION,
} from "@/lib/silences";
import Popover, { PopoverContent, PopoverTrigger } from "./Popover";
import { useI18n } from "./I18nProvider";
import type { MessageKey } from "@/lib/i18n";

/**
 * What every tool gets to work with: the targets it would act on, plus the
 * store actions that apply them. Computed once per render so `count` and `run`
 * can never disagree about what the tool is about to touch.
 */
type ToolContext = {
  fillerIds: number[];
  deletedFillerIds: number[];
  silenceRanges: ReturnType<typeof findSilenceRanges>;
  silenceCuts: ReturnType<typeof findSilenceCuts>;
  deleteWords: (ids: number[]) => void;
  restoreWords: (ids: number[]) => void;
  cutRanges: (ranges: { start: number; end: number }[]) => void;
  restoreRanges: (ranges: { start: number; end: number }[]) => void;
};

type ToolDef = {
  key: string;
  labelKey: MessageKey;
  titleKey: MessageKey;
  Icon: LucideIcon;
  /** How much the tool would touch. Zero hides it from the menu entirely. */
  count: (ctx: ToolContext) => number;
  run: (ctx: ToolContext) => void;
};

/** The bulk cleanups offered in the transcript's Tools menu, in menu order. */
const TOOLS: ToolDef[] = [
  {
    key: "remove-fillers",
    labelKey: "tools.removeFillers",
    titleKey: "tools.removeFillersTitle",
    Icon: WandSparkles,
    count: (ctx) => ctx.fillerIds.length,
    run: (ctx) => ctx.deleteWords(ctx.fillerIds),
  },
  {
    key: "restore-fillers",
    labelKey: "tools.restoreFillers",
    titleKey: "tools.restoreFillersTitle",
    Icon: Undo2,
    count: (ctx) => ctx.deletedFillerIds.length,
    run: (ctx) => ctx.restoreWords(ctx.deletedFillerIds),
  },
  {
    key: "remove-silences",
    labelKey: "tools.removeSilences",
    titleKey: "tools.removeSilencesTitle",
    Icon: VolumeX,
    count: (ctx) => ctx.silenceRanges.length,
    run: (ctx) => ctx.cutRanges(ctx.silenceRanges),
  },
  {
    key: "restore-silences",
    labelKey: "tools.restoreSilences",
    titleKey: "tools.restoreSilencesTitle",
    Icon: Undo2,
    count: (ctx) => ctx.silenceCuts.length,
    run: (ctx) => ctx.restoreRanges(ctx.silenceCuts),
  },
];

/**
 * Collapses the bulk transcript cleanups behind one trigger. Tools with nothing
 * to do drop out, so the badge doubles as "how many cleanups are available
 * right now" — and the menu hides itself when that leaves none.
 */
export default function TranscriptToolsMenu() {
  const { t } = useI18n();
  const words = useEditorStore((s) => s.words);
  const duration = useEditorStore((s) => s.duration);
  const manualCuts = useEditorStore((s) => s.manualCuts);
  const deleteWords = useEditorStore((s) => s.deleteWords);
  const restoreWords = useEditorStore((s) => s.restoreWords);
  const cutRanges = useEditorStore((s) => s.cutRanges);
  const restoreRanges = useEditorStore((s) => s.restoreRanges);

  const [open, setOpen] = useState(false);
  const panelId = useId();

  const ctx = useMemo<ToolContext>(
    () => ({
      fillerIds: findFillerWordIds(words),
      deletedFillerIds: findDeletedFillerWordIds(words),
      silenceRanges: findSilenceRanges(words, duration, manualCuts),
      silenceCuts: findSilenceCuts(words, manualCuts),
      deleteWords,
      restoreWords,
      cutRanges,
      restoreRanges,
    }),
    [
      words,
      duration,
      manualCuts,
      deleteWords,
      restoreWords,
      cutRanges,
      restoreRanges,
    ]
  );

  const available = useMemo(
    () =>
      TOOLS.map((tool) => ({ tool, count: tool.count(ctx) })).filter(
        (t) => t.count > 0
      ),
    [ctx]
  );

  if (available.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen} placement="bottom-end" backdrop>
      <div className="relative z-30 shrink-0">
        <PopoverTrigger>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={panelId}
            title={t("tools.bulk")}
            onClick={() => setOpen((v) => !v)}
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <Zap size={14} />
            <span className="hidden sm:inline">{t("common.tools")}</span>
            <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
              {available.length}
            </span>
          </button>
        </PopoverTrigger>

        <PopoverContent
          id={panelId}
          role="menu"
          aria-label={t("common.tools")}
          className="z-40 w-[15rem] overflow-hidden p-1.5"
        >
          {available.map(({ tool, count }) => (
            <button
              key={tool.key}
              type="button"
              role="menuitem"
              title={t(tool.titleKey, {
                seconds: MIN_SILENCE_DURATION,
              })}
              onClick={() => {
                tool.run(ctx);
                setOpen(false);
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-zinc-700 transition hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/80"
            >
              <span className="shrink-0 text-zinc-400 dark:text-zinc-500">
                <tool.Icon size={14} />
              </span>
              <span className="flex-1">{t(tool.labelKey)}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                {count}
              </span>
            </button>
          ))}
        </PopoverContent>
      </div>
    </Popover>
  );
}
