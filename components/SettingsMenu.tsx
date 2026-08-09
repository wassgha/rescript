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

const MENU_LINKS = [
  { label: "Support / feedback", href: DISCORD_INVITE_URL, Icon: DiscordIcon },
  {
    label: "Report an issue",
    href: `${GITHUB_REPO_URL}/issues`,
    Icon: Bug,
  },
  { label: "Homepage", href: WEBSITE_URL, Icon: HomeIcon },
  { label: "Github", href: GITHUB_REPO_URL, Icon: GitHubIcon },
  { label: "Follow on X", href: X_PROFILE_URL, Icon: XIcon },
] as const;

const TRANSCRIPTION_SETTINGS_STORAGE_KEY = "rescript.transcription.settings";
const DEFAULT_TRANSCRIPTION_SETTINGS = {
  maxSpeakers: 2,
  onsetThreshold: 0.7,
};

function readTranscriptionSettings() {
  if (typeof window === "undefined" || !window.localStorage) {
   return DEFAULT_TRANSCRIPTION_SETTINGS;
  }
  try {
   const raw = window.localStorage.getItem(TRANSCRIPTION_SETTINGS_STORAGE_KEY);
   if (!raw) return DEFAULT_TRANSCRIPTION_SETTINGS;
   const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_TRANSCRIPTION_SETTINGS>;
   return {
     maxSpeakers: Number.isFinite(parsed.maxSpeakers)
       ? Math.max(1, Math.round(Number(parsed.maxSpeakers)))
       : DEFAULT_TRANSCRIPTION_SETTINGS.maxSpeakers,
     onsetThreshold: Number.isFinite(parsed.onsetThreshold)
       ? Math.max(0, Math.min(1, Number(parsed.onsetThreshold)))
       : DEFAULT_TRANSCRIPTION_SETTINGS.onsetThreshold,
   };
  } catch {
   return DEFAULT_TRANSCRIPTION_SETTINGS;
  }
}

/**
 * Top-bar settings popover. Houses appearance, transcript source, and social
 * links for now — structure is section-based so more prefs can land here later.
 */
export default function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { appearance, setAppearance } = useAppearance();
  const { enabled: telemetry, setEnabled: setTelemetry } = useTelemetryPref();
  const [transcriptionSettings, setTranscriptionSettings] = useState(() =>
    readTranscriptionSettings()
  );

  const commitTranscriptionSettings = (
    patch: Partial<typeof DEFAULT_TRANSCRIPTION_SETTINGS>
  ) => {
    const next = { ...transcriptionSettings, ...patch };
    const normalized = {
      maxSpeakers: Math.max(1, Math.round(Number(next.maxSpeakers))),
      onsetThreshold: Math.max(0, Math.min(1, Number(next.onsetThreshold))),
    };
    setTranscriptionSettings(normalized);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          TRANSCRIPTION_SETTINGS_STORAGE_KEY,
          JSON.stringify(normalized)
        );
      }
    } catch {
      // localStorage may be unavailable in private browsing or storage-full modes.
    }
  };

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
            aria-label="Settings"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={panelId}
            title="Settings"
            onClick={() => setOpen((v) => !v)}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <Settings size={16} />
          </button>
        </PopoverTrigger>

        <PopoverContent
          id={panelId}
          role="dialog"
          aria-label="Settings"
          className="z-40 w-[15rem] overflow-hidden"
        >
          <section className="border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              Appearance
            </p>
            <div
              className="grid grid-cols-2 gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800"
              role="radiogroup"
              aria-label="Appearance"
            >
              <AppearanceOption
                value="light"
                label="Light"
                icon={Sun}
                selected={appearance === "light"}
                onSelect={setAppearance}
              />
              <AppearanceOption
                value="dark"
                label="Dark"
                icon={Moon}
                selected={appearance === "dark"}
                onSelect={setAppearance}
              />
            </div>
          </section>

          <section className="border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              Transcription
            </p>
            <div className="space-y-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                  Max speakers
                </span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={transcriptionSettings.maxSpeakers}
                  onChange={(e) =>
                    commitTranscriptionSettings({
                      maxSpeakers: Number(e.target.value || 1),
                    })
                  }
                  className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-[12px] outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                  Onset threshold
                </span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={transcriptionSettings.onsetThreshold}
                  onChange={(e) =>
                    commitTranscriptionSettings({
                      onsetThreshold: Number(e.target.value || 0),
                    })
                  }
                  className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-[12px] outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </label>
            </div>
          </section>

          <section className="border-b border-zinc-100 px-1.5 py-1.5 dark:border-zinc-800">
            {MENU_LINKS.map(({ label, href, Icon }) => (
              <a
                key={label}
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
                <span className="flex-1">{label}</span>
                <ExternalLink
                  size={12}
                  className="shrink-0 text-zinc-300 dark:text-zinc-600"
                />
              </a>
            ))}
          </section>

          <section className="px-2 py-2.5">
            <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              Privacy
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
                  Help improve the app
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-zinc-400 dark:text-zinc-500">
                  Send anonymous feature usage statistics and crash reports.
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
