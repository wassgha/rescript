"use client";

import { useId, useState } from "react";
import { Bug, ExternalLink, HomeIcon, Moon, Settings, Sun } from "lucide-react";
import {
  DiscordIcon,
  DISCORD_INVITE_URL,
  GitHubIcon,
  GITHUB_REPO_URL,
  WEBSITE_URL,
  XIcon,
  X_PROFILE_URL,
} from "./SocialLinks";
import { useAppearance } from "@/hooks/useAppearance";
import { useTelemetryPref } from "@/hooks/useTelemetryPref";
import Popover, { PopoverContent, PopoverTrigger } from "./Popover";
import type { Appearance } from "@/lib/theme";
import { useI18n } from "./I18nProvider";
import { useEditorStore } from "@/lib/store";
import {
  TRANSCRIPT_LANGUAGE_PREFERENCE_ORDER,
  TRANSCRIPT_LANGUAGES,
  type TranscriptLanguagePreference,
} from "@/lib/languages";
import type { UiLocalePreference } from "@/lib/i18n";

const MENU_LINKS = [
  { labelKey: "settings.support", href: DISCORD_INVITE_URL, Icon: DiscordIcon },
  {
    labelKey: "settings.reportIssue",
    href: `${GITHUB_REPO_URL}/issues`,
    Icon: Bug,
  },
  { labelKey: "settings.homepage", href: WEBSITE_URL, Icon: HomeIcon },
  { labelKey: "settings.github", href: GITHUB_REPO_URL, Icon: GitHubIcon },
  { labelKey: "settings.followX", href: X_PROFILE_URL, Icon: XIcon },
] as const;

/**
 * Top-bar settings popover. Houses appearance, transcript source, and social
 * links for now — structure is section-based so more prefs can land here later.
 */
export default function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { appearance, setAppearance } = useAppearance();
  const { enabled: telemetry, setEnabled: setTelemetry } = useTelemetryPref();
  const { t, preference, setPreference } = useI18n();
  const transcriptLanguage = useEditorStore((s) => s.transcriptLanguage);
  const setTranscriptLanguage = useEditorStore((s) => s.setTranscriptLanguage);

  return (
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
            aria-label={t("common.settings")}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={panelId}
            title={t("common.settings")}
            onClick={() => setOpen((v) => !v)}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <Settings size={16} />
          </button>
        </PopoverTrigger>

        <PopoverContent
          id={panelId}
          role="dialog"
          aria-label={t("common.settings")}
          className="z-40 w-[15rem] overflow-hidden"
        >
          <section className="border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              {t("settings.appearance")}
            </p>
            <div
              className="grid grid-cols-2 gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800"
              role="radiogroup"
              aria-label={t("settings.appearance")}
            >
              <AppearanceOption
                value="light"
                label={t("settings.light")}
                icon={Sun}
                selected={appearance === "light"}
                onSelect={setAppearance}
              />
              <AppearanceOption
                value="dark"
                label={t("settings.dark")}
                icon={Moon}
                selected={appearance === "dark"}
                onSelect={setAppearance}
              />
            </div>
          </section>

          <section className="border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <label className="block text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              {t("settings.interfaceLanguage")}
              <select
                value={preference}
                onChange={(event) =>
                  setPreference(event.target.value as UiLocalePreference)
                }
                className="mt-2 block h-8 w-full rounded-lg border border-zinc-200 bg-white px-2 text-[12px] text-zinc-700 outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              >
                <option value="system">{t("common.system")}</option>
                <option value="en">{t("language.english")}</option>
                <option value="zh-CN">{t("language.simplifiedChinese")}</option>
              </select>
            </label>
          </section>

          <section className="border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <label className="block text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              {t("settings.transcriptLanguage")}
              <select
                value={transcriptLanguage}
                onChange={(event) =>
                  setTranscriptLanguage(
                    event.target.value as TranscriptLanguagePreference
                  )
                }
                className="mt-2 block h-8 w-full rounded-lg border border-zinc-200 bg-white px-2 text-[12px] text-zinc-700 outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              >
                {TRANSCRIPT_LANGUAGE_PREFERENCE_ORDER.map((id) => (
                  <option key={id} value={id}>
                    {id === "auto"
                      ? t("common.auto")
                      : TRANSCRIPT_LANGUAGES[id].nativeLabel}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1.5 text-[10px] leading-snug text-zinc-400 dark:text-zinc-500">
              {t("settings.transcriptLanguageHelp")}
            </p>
          </section>

          <section className="border-b border-zinc-100 px-1.5 py-1.5 dark:border-zinc-800">
            {MENU_LINKS.map(({ labelKey, href, Icon }) => (
              <a
                key={labelKey}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                // Keep the click on the anchor — popover dismiss listeners must
                // not treat this as an outside press or swallow navigation.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-zinc-700 transition hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/80"
              >
                <span className="shrink-0 text-zinc-400 dark:text-zinc-500">
                  <Icon size={14} />
                </span>
                <span className="flex-1">{t(labelKey)}</span>
                <ExternalLink
                  size={12}
                  className="shrink-0 text-zinc-300 dark:text-zinc-600"
                />
              </a>
            ))}
          </section>

          <section className="px-2 py-2.5">
            <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              {t("settings.privacy")}
            </p>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={telemetry}
                onChange={(e) => setTelemetry(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-transparent"
              />
              <span>
                <span className="block text-[12px] text-zinc-700 dark:text-zinc-300">
                  {t("settings.helpImprove")}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-zinc-400 dark:text-zinc-500">
                  {t("settings.telemetryHelp")}
                </span>
              </span>
            </label>
          </section>

        </PopoverContent>
      </div>
    </Popover>
  );
}

function AppearanceOption({
  value,
  label,
  icon: Icon,
  selected,
  onSelect,
}: {
  value: Appearance;
  label: string;
  icon: typeof Sun;
  selected: boolean;
  onSelect: (value: Appearance) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(value)}
      className={`flex cursor-pointer items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium transition ${
        selected
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
          : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}
