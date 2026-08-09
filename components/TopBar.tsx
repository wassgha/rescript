"use client";

import { useEditorStore } from "@/lib/store";
import Image from "next/image";
import logo from "@/assets/logo.png";
import { useWindowChrome } from "@/hooks/useWindowChrome";
import { useI18n } from "./I18nProvider";

function truncateMiddle(value: string, maxLength = 40): string {
  if (value.length <= maxLength) return value;
  const ellipsis = "...";
  const charsToShow = maxLength - ellipsis.length;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  return `${value.slice(0, frontChars)}${ellipsis}${value.slice(value.length - backChars)}`;
}

export default function TopBar({ children }: { children?: React.ReactNode }) {
  const { t } = useI18n();
  const { draggable, trafficLights } = useWindowChrome();
  const videoFile = useEditorStore((s) => s.videoFile);
  const reset = useEditorStore((s) => s.reset);

  return (
    <header
      className={`flex h-13 shrink-0 items-center gap-2 border-b border-zinc-200 bg-white pr-3 transition-[padding-left] duration-200 ease-out dark:border-zinc-800 dark:bg-zinc-900 ${
        draggable ? "app-drag" : ""
      } ${trafficLights ? "pl-22" : "pl-3"}`}
    >
      <button
        onClick={reset}
        title={t("topbar.startOver")}
        className="app-no-drag flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <Image
          src={logo}
          alt="Rescript"
          width={18}
          height={18}
          priority
          className="rounded-sm"
        />
      </button>
      <span className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
        Rescript
      </span>

      {videoFile && (
        <div
          className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 items-center text-[13px] text-zinc-500 sm:flex dark:text-zinc-400"
          title={videoFile.name}
        >
          {truncateMiddle(videoFile.name)}
        </div>
      )}

      <div className="app-no-drag ml-auto flex items-center gap-1">
        {children}
      </div>
    </header>
  );
}
