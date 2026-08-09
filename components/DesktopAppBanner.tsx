"use client";

import { useState } from "react";
import { X } from "lucide-react";
import {
  downloadUrlFor,
  isElectron,
  PLATFORM_LABEL,
  type Platform,
} from "@/lib/platform";
import { usePlatform } from "@/hooks/usePlatform";
import { useI18n } from "./I18nProvider";

const DISMISSED_STORAGE_KEY = "rescript:desktop-banner-dismissed";

/** localStorage throws in private-mode Safari and when storage is full. */
function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, "1");
  } catch {
    // Ignore — the banner simply comes back next session.
  }
}

function AppleIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M17.05 12.54c-.03-2.5 2.04-3.7 2.13-3.76-1.16-1.7-2.97-1.93-3.61-1.96-1.54-.15-3 .9-3.78.9-.78 0-1.98-.88-3.25-.86-1.67.03-3.21.97-4.07 2.46-1.73 3-.44 7.45 1.25 9.89.82 1.19 1.8 2.53 3.08 2.48 1.24-.05 1.71-.8 3.2-.8 1.5 0 1.92.8 3.23.78 1.33-.02 2.18-1.21 3-2.41.94-1.38 1.33-2.72 1.35-2.79-.03-.01-2.59-1-2.62-3.93M14.6 4.6c.68-.83 1.14-1.98 1.02-3.13-.98.04-2.17.65-2.88 1.48-.63.73-1.19 1.9-1.04 3.02 1.1.09 2.21-.55 2.9-1.37" />
    </svg>
  );
}

function WindowsIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M3 5.48 10.2 4.5v6.94H3zm0 13.04 7.2.98v-6.85H3zM11.05 4.38 21 3v8.44h-9.95zm0 15.24L21 21v-8.35h-9.95z" />
    </svg>
  );
}

function LinuxIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 1.5c-2.3 0-3.6 1.7-3.6 4.1 0 1 .13 1.83.1 2.6-.04.83-.5 1.5-1.1 2.4-.72 1.05-1.35 2.1-1.6 3.35-.16.8-.5 1.4-.94 1.98-.4.53-.44 1.1-.1 1.43.36.36 1 .28 1.5.5.45.2.72.6 1.22.9.5.3 1.2.44 2.2.24.72-.15 1.4-.15 2.5-.02 1.05.13 1.83.1 2.5-.1.6-.18 1-.55 1.5-.83.5-.28 1.1-.24 1.45-.6.33-.35.24-.9-.17-1.43-.45-.58-.75-1.2-.9-2-.24-1.24-.87-2.3-1.6-3.34-.6-.9-1.05-1.57-1.1-2.4-.03-.77.1-1.6.1-2.6 0-2.4-1.3-4.1-3.6-4.1zm-1.35 3.1c.4 0 .72.42.72.94 0 .52-.32.94-.72.94-.4 0-.72-.42-.72-.94 0-.52.32-.94.72-.94zm2.75 0c.4 0 .72.42.72.94 0 .52-.32.94-.72.94-.4 0-.72-.42-.72-.94 0-.52.32-.94.72-.94zM12 7.35c.85 0 1.63.35 2 .8.2.24.14.5-.14.72l-1.4 1.08c-.3.23-.62.23-.92 0l-1.4-1.08c-.28-.22-.34-.48-.14-.72.37-.45 1.15-.8 2-.8z" />
    </svg>
  );
}

/** Nothing for an unrecognised desktop browser — its button reads "Download". */
function PlatformIcon({ platform }: { platform: Platform }) {
  if (platform === "mac-arm" || platform === "mac-intel")
    return <AppleIcon size={14} />;
  if (platform === "windows") return <WindowsIcon size={13} />;
  if (platform === "linux") return <LinuxIcon size={14} />;
  return null;
}

/**
 * Web-only nudge toward the desktop build, which runs transcription and
 * exports natively instead of through WebAssembly. Hidden inside the Electron
 * shell, on phones and tablets (there is no mobile build to pitch), and once
 * the user dismisses it.
 */
export default function DesktopAppBanner() {
  const { t } = useI18n();
  const platform = usePlatform();
  const [dismissed, setDismissed] = useState(
    () => isElectron || readDismissed(),
  );

  if (isElectron || dismissed || platform === "mobile") return null;

  const label = PLATFORM_LABEL[platform];

  return (
    <div className="relative flex h-11 shrink-0 items-center justify-center gap-3 border-b border-blue-200/60 bg-gradient-to-b from-blue-50/70 to-blue-100/50 pr-11 pl-3 text-[13px] text-blue-900 dark:border-blue-400/15 dark:from-blue-950/40 dark:to-blue-900/25 dark:text-blue-100">
      <p className="truncate">
        <span className="hidden sm:inline">
          {t("banner.faster")}{" "}
        </span>
        {t("banner.getDesktop")}
      </p>
      <a
        href={downloadUrlFor(platform)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/70 pr-3.5 pl-3 text-[12px] font-medium text-blue-700 ring-1 ring-blue-300/60 transition hover:bg-white hover:ring-blue-400/70 dark:bg-white/10 dark:text-blue-100 dark:ring-white/15 dark:hover:bg-white/15 dark:hover:ring-white/25"
      >
        <PlatformIcon platform={platform} />
        {label ? t("banner.downloadFor", { platform: label }) : t("common.download")}
      </a>
      <button
        onClick={() => {
          setDismissed(true);
          writeDismissed();
        }}
        title={t("banner.dismiss")}
        aria-label={t("banner.dismiss")}
        className="absolute right-2.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-blue-500 transition hover:bg-blue-500/10 hover:text-blue-800 dark:text-blue-300 dark:hover:bg-white/10 dark:hover:text-blue-100"
      >
        <X size={14} />
      </button>
    </div>
  );
}
