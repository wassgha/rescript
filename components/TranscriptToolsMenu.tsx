"use client";

import { useId, useMemo, useState } from "react";
import { Undo2, VolumeX, WandSparkles, Zap, type LucideIcon } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { findDeletedFillerWordIds, findFillerWordIds } from "@/lib/fillers";
import {
  findSilenceCuts,
  findSilenceRanges,
  silenceKeep,
  SILENCE_LENGTH_RANGE,
} from "@/lib/silences";
import { useSilenceSettings } from "@/hooks/useSilenceSettings";
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
  /** Whether any silence is left to shorten at the slider's shortest length. */
  anySilence: boolean;
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
  /** How much the tool would touch. Zero hides it unless `shown` says otherwise. */
  count: (ctx: ToolContext) => number;
  /** Keep the tool in the menu (disabled) even while `count` is zero. */
  shown?: (ctx: ToolContext) => boolean;
  /** Offers the silence length and after/before split sliders under the tool. */
  silenceSettings?: boolean;
  run: (ctx: ToolContext) => void;
};

const SLIDER =
  "h-5 cursor-pointer appearance-none bg-transparent focus-visible:outline-none [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-zinc-700 dark:[&::-moz-range-thumb]:bg-zinc-200 [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-zinc-200 dark:[&::-moz-range-track]:bg-zinc-700 [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-zinc-200 dark:[&::-webkit-slider-runnable-track]:bg-zinc-700 [&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-zinc-700 dark:[&::-webkit-slider-thumb]:bg-zinc-200 focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-zinc-400 focus-visible:[&::-moz-range-thumb]:ring-2 focus-visible:[&::-moz-range-thumb]:ring-zinc-400";
const SLIDER_VALUE = "shrink-0 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400";

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
    key: "shorten-silences",
    labelKey: "tools.shortenSilences",
    titleKey: "tools.shortenSilencesTitle",
    Icon: VolumeX,
    count: (ctx) => ctx.silenceRanges.length,
    // A long length can leave nothing to cut; the sliders must stay reachable.
    shown: (ctx) => ctx.anySilence,
    silenceSettings: true,
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
 * right now" — and the menu hides itself when that leaves none. "Shorten
 * silences" stays while any silence exists, so its sliders are reachable.
 */
export default function TranscriptToolsMenu() {
  const { t, locale } = useI18n();
  const silence = useSilenceSettings();
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
      silenceRanges: findSilenceRanges(words, duration, manualCuts, silence.length, silence.split),
      anySilence:
        findSilenceRanges(words, duration, manualCuts, SILENCE_LENGTH_RANGE.min, silence.split)
          .length > 0,
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
      silence.length,
      silence.split,
      deleteWords,
      restoreWords,
      cutRanges,
      restoreRanges,
    ]
  );

  const listed = useMemo(
    () =>
      TOOLS.map((tool) => ({ tool, count: tool.count(ctx) })).filter(
        (t) => t.count > 0 || (t.tool.shown?.(ctx) ?? false)
      ),
    [ctx]
  );
  const available = listed.filter((t) => t.count > 0).length;

  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const seconds = (value: number) => t("tools.seconds", { seconds: number(value) });
  const keep = silenceKeep(silence.length, silence.split);

  if (listed.length === 0) return null;

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
              {available}
            </span>
          </button>
        </PopoverTrigger>

        <PopoverContent
          id={panelId}
          role="menu"
          aria-label={t("common.tools")}
          className="z-40 w-[15rem] overflow-hidden p-1.5"
        >
          {listed.map(({ tool, count }) => (
            <div key={tool.key}>
              <button
                type="button"
                role="menuitem"
                disabled={count === 0}
                title={t(tool.titleKey, { seconds: seconds(silence.length) })}
                onClick={() => {
                  tool.run(ctx);
                  setOpen(false);
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-default disabled:text-zinc-400 disabled:hover:bg-transparent dark:text-zinc-300 dark:hover:bg-zinc-800/80 dark:disabled:text-zinc-500"
              >
                <span className="shrink-0 text-zinc-400 dark:text-zinc-500">
                  <tool.Icon size={14} />
                </span>
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1">
                  <span>{t(tool.labelKey)}</span>
                  {tool.silenceSettings && (
                    <span className="text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                      {t("tools.shortenTo", { seconds: seconds(silence.length) })}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                  {count}
                </span>
              </button>
              {tool.silenceSettings && (
                <div className="mx-2.5 mb-1.5">
                  <input
                    type="range"
                    aria-label={t("tools.silenceLength")}
                    title={t("tools.silenceLength")}
                    min={SILENCE_LENGTH_RANGE.min}
                    max={SILENCE_LENGTH_RANGE.max}
                    step={SILENCE_LENGTH_RANGE.step}
                    value={silence.length}
                    aria-valuetext={seconds(silence.length)}
                    onChange={(e) => silence.setLength(Number(e.target.value))}
                    className={`w-full ${SLIDER}`}
                  />
                  <div className="flex items-center gap-2">
                    <span className={`w-9 ${SLIDER_VALUE}`}>{seconds(keep.after)}</span>
                    <input
                      type="range"
                      aria-label={t("tools.silenceSplit")}
                      title={t("tools.silenceSplit")}
                      min={0}
                      max={silence.length}
                      step={0.01}
                      value={keep.after}
                      aria-valuetext={t("tools.silenceSplitValue", {
                        after: seconds(keep.after),
                        before: seconds(keep.before),
                      })}
                      onChange={(e) => silence.setSplit(Number(e.target.value) / silence.length)}
                      className={`min-w-0 flex-1 ${SLIDER}`}
                    />
                    <span className={`w-9 text-right ${SLIDER_VALUE}`}>{seconds(keep.before)}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-zinc-400 dark:text-zinc-500">
                    <span>{t("tools.afterWord")}</span>
                    <span>{t("tools.beforeWord")}</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </PopoverContent>
      </div>
    </Popover>
  );
}
