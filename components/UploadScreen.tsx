"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import {
  AudioLines,
  Clapperboard,
  Film,
  Loader2,
  Music,
  Scissors,
  ShieldAlert,
  Trash2,
  Type,
} from "lucide-react";
import logo from "@/assets/logo.png";
import SocialLinks, { WEBSITE_URL } from "./SocialLinks";
import SettingsMenu from "./SettingsMenu";
import ModelSelector, {
  LanguageSection,
  ModelOption,
  ModelOptionSeparator,
} from "./ModelSelector";
import ImportTranscriptOption from "./ImportTranscriptOption";
import { MODEL_ORDER } from "@/lib/models";
import { useCrossOriginIsolated } from "@/hooks/useCrossOriginIsolated";
import { detectMediaKind, MEDIA_ACCEPT } from "@/lib/media";
import { formatTime } from "@/lib/edits";
import {
  listProjects,
  type ProjectMeta,
} from "@/lib/projects";
import { isElectron } from "@/lib/platform";
import { useEditorStore } from "@/lib/store";
import type { SpeakerInfo, Word } from "@/lib/types";
import { useI18n } from "./I18nProvider";
import {
  formatRelativeTime,
  localizeRuntimeMessage,
} from "@/lib/i18n";

// The three media cards that stand in for the upload icon. Each carries its
// resting transform plus the fanned-out one, applied either on hover (via the
// dropzone's `group`) or while a file is being dragged over.
const CARDS = [
  {
    icon: Film,
    size: "h-[4.25rem] w-[3.25rem]",
    iconSize: 18,
    bars: ["w-7", "w-4"],
    fan: "-rotate-[18deg] -translate-x-10 -translate-y-1.5",
    rest: "-rotate-[11deg] -translate-x-5 group-hover:-rotate-[18deg] group-hover:-translate-x-10 group-hover:-translate-y-1.5",
  },
  {
    icon: AudioLines,
    size: "h-20 w-16",
    iconSize: 22,
    bars: ["w-9", "w-5"],
    fan: "z-10 -translate-y-2.5",
    rest: "z-10 group-hover:-translate-y-2.5",
  },
  {
    icon: Music,
    size: "h-[4.25rem] w-[3.25rem]",
    iconSize: 18,
    bars: ["w-7", "w-4"],
    fan: "rotate-[18deg] translate-x-10 -translate-y-1.5",
    rest: "rotate-[11deg] translate-x-5 group-hover:rotate-[18deg] group-hover:translate-x-10 group-hover:-translate-y-1.5",
  },
] as const;

function MediaCards({ dragging }: { dragging: boolean }) {
  return (
    <div className="pointer-events-none relative mb-5 flex h-24 w-full items-center justify-center">
      {CARDS.map(({ icon: Icon, size, iconSize, bars, rest, fan }, i) => (
        <div
          key={i}
          className={`absolute flex flex-col items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white transition-transform duration-300 ease-out dark:border-zinc-800 ${dragging ? "dark:bg-zinc-900" : "dark:bg-zinc-900 group-hover:dark:bg-zinc-900"} ${size} ${dragging ? fan : rest
            }`}
        >
          <Icon size={iconSize} className="text-neutral-400 dark:text-neutral-500" />
          <div className="flex flex-col items-center gap-1">
            {bars.map((w) => (
              <span key={w} className={`block h-[3px] rounded-full bg-zinc-200 dark:bg-zinc-700 ${w}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RecentProjects({
  projects,
  busyId,
  onOpen,
  onRemove,
}: {
  projects: ProjectMeta[];
  busyId: string | null;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { locale, t } = useI18n();
  if (projects.length === 0) return null;
  return (
    <div className="mt-6">
      <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
        {t("upload.recentProjects")}
      </p>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white/80 dark:divide-zinc-800 dark:border-zinc-700 dark:bg-zinc-900/80">
        {projects.map((p) => {
          const KindIcon = p.mediaKind === "audio" ? AudioLines : Film;
          const opening = busyId === p.id;
          return (
            <li key={p.id}>
              <div className="flex items-center gap-1 pr-1">
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => onOpen(p.id)}
                  className="flex cursor-pointer min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition hover:bg-zinc-50 disabled:opacity-60 dark:hover:bg-zinc-800/60"
                >
                  <KindIcon size={16} className="shrink-0 text-zinc-400 mx-2 dark:text-zinc-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
                      {p.name}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-zinc-400 dark:text-zinc-500">
                      {formatRelativeTime(locale, p.updatedAt)}
                      {p.duration > 0 ? ` · ${formatTime(p.duration)}` : ""}
                      {` · ${p.mediaKind === "audio" ? t("export.audio") : t("export.video")}`}
                    </span>
                  </span>
                  {opening && (
                    <Loader2 size={14} className="shrink-0 animate-spin text-zinc-400" />
                  )}
                </button>
                <button
                  type="button"
                  title={t("upload.removeRecent")}
                  disabled={busyId !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(p.id);
                  }}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function UploadScreen({
  onFile,
}: {
  onFile: (
    file: File,
    options?: { words?: Word[]; speakers?: SpeakerInfo[] }
  ) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The pipeline needs SharedArrayBuffer, so don't accept a file until the page
  // is confirmed cross-origin isolated — transcription would fail immediately.
  const isolation = useCrossOriginIsolated();
  const ready = isolation === "ready";
  const source = useEditorStore((s) => s.source);
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  const openProject = useEditorStore((s) => s.openProject);
  const removeProject = useEditorStore((s) => s.removeProject);
  const { t } = useI18n();

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (err) {
      console.warn("Failed to list saved projects.", err);
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // IndexedDB is an external store; load once on mount for the recent list.
    void listProjects()
      .then((rows) => {
        if (!cancelled) setProjects(rows);
      })
      .catch((err) => {
        console.warn("Failed to list saved projects.", err);
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!ready) return;
      const file = files?.[0];
      if (!file) return;
      if (!detectMediaKind(file)) {
        alert(t("editor.chooseMedia"));
        return;
      }
      const { source, pendingTranscript: pending } = useEditorStore.getState();
      if (source === "import") {
        if (!pending) {
          alert(t("editor.chooseTranscript"));
          return;
        }
        onFile(file, { words: pending.words, speakers: pending.speakers });
        return;
      }
      onFile(file);
    },
    [onFile, ready, t]
  );

  const handleOpen = useCallback(
    async (id: string) => {
      if (!ready) return;
      setBusyId(id);
      try {
        await openProject(id);
      } catch (err) {
        console.error(err);
        alert(
          err instanceof Error
            ? localizeRuntimeMessage(err.message, t)
            : t("error.openProject")
        );
        await refreshProjects();
      } finally {
        setBusyId(null);
      }
    },
    [openProject, ready, refreshProjects, t]
  );

  const handleRemove = useCallback(
    async (id: string) => {
      try {
        await removeProject(id);
        await refreshProjects();
      } catch (err) {
        console.error(err);
        alert(t("error.removeProject"));
      }
    },
    [removeProject, refreshProjects, t]
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-gradient-to-b from-zinc-50 to-neutral-50/50 dark:from-zinc-950 dark:to-zinc-900/50">
      {/* min-h-full + items-center centers when content fits; the outer
          overflow-y-auto still lets short viewports (mobile) scroll the top. */}
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="w-full max-w-xl">
          {!isElectron && (
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <a href={WEBSITE_URL} className="hover:opacity-80 transition-opacity">
                <div className="flex min-w-0 items-center">
                  <Image
                    src={logo}
                    alt="Rescript"
                    width={24}
                    height={24}
                    priority
                    className="rounded-sm border border-zinc-200 dark:border-zinc-700"
                  />
                  <p className="ml-2 text-[15px] font-medium text-zinc-800 dark:text-zinc-100">
                    Rescript
                  </p>
                </div>
              </a>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <SettingsMenu />
                <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-700 mr-1" />
                <ModelSelector groupLabel={t("model.transcriptSource")}>
                  {MODEL_ORDER.map((id) => (
                    <ModelOption key={id} id={id} />
                  ))}
                  <ModelOptionSeparator />
                  <LanguageSection />
                  <ModelOptionSeparator />
                  <ImportTranscriptOption />
                </ModelSelector>
              </div>
            </div>
          )}
          {/*
            Native <label htmlFor> opens the file dialog without a synthetic
            input.click(). display:none inputs + .click() fail in some Chromium
            setups (DnD still works), which matches "browse does nothing".
          */}
          <label
            htmlFor={inputId}
            aria-disabled={!ready}
            tabIndex={ready ? 0 : -1}
            onClick={(e) => {
              if (!ready) e.preventDefault();
            }}
            onKeyDown={(e) => {
              if (!ready) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (ready) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFiles(e.dataTransfer.files);
            }}
            className={`group flex flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-white/80 px-8 py-14 text-center transition dark:bg-zinc-900/40 ${!ready
              ? "cursor-default border-zinc-200 dark:border-zinc-700"
              : dragging
                ? "cursor-pointer border-neutral-500 bg-neutral-50/80 dark:border-neutral-600 dark:bg-zinc-900/60"
                : "cursor-pointer border-zinc-300 hover:border-neutral-400 hover:bg-white dark:border-zinc-700 dark:hover:border-neutral-600 dark:hover:bg-zinc-900/60"
              }`}
          >
            {ready ? (
              <MediaCards dragging={dragging} />
            ) : (
              <div
                className={`mb-3 flex h-12 w-12 items-center justify-center rounded-full ${isolation === "unavailable"
                  ? "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
              >
                {isolation === "unavailable" ? (
                  <ShieldAlert size={20} />
                ) : (
                  <Loader2 size={20} className="animate-spin" />
                )}
              </div>
            )}
            {isolation === "unavailable" ? (
              <>
                <p className="text-[15px] font-medium text-zinc-800 dark:text-zinc-100">
                  {t("upload.unsupported")}
                </p>
                <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-zinc-400 dark:text-zinc-500">
                  {t("upload.unsupportedHelp")}
                </p>
              </>
            ) : ready ? (
              <>
                <p className="text-[15px] font-medium text-zinc-800 dark:text-zinc-100">
                  {t("upload.dropOrBrowse", {
                    browse: t("upload.browse"),
                  })}
                </p>
                <p className="mt-1 text-[13px] text-zinc-400 dark:text-zinc-500">
                  {source === "import"
                    ? pendingTranscript
                      ? t("upload.willUseTranscript", {
                          name: pendingTranscript.name,
                        })
                      : t("upload.chooseTranscriptFirst")
                    : t("upload.mediaFormats")}
                </p>
              </>
            ) : (
              <>
                <p className="text-[15px] font-medium text-zinc-800 dark:text-zinc-100">{t("upload.gettingReady")}</p>
                <p className="mt-1 text-[13px] text-zinc-400 dark:text-zinc-500">
                  {t("upload.gettingReadyHelp")}
                </p>
              </>
            )}
            <input
              id={inputId}
              ref={inputRef}
              type="file"
              accept={MEDIA_ACCEPT}
              disabled={!ready}
              // Visually hidden but present in the layout tree — display:none
              // breaks programmatic / label-activated pickers in some browsers.
              className="sr-only"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </label>

          {/* On desktop the recent list lives in the native File menu instead. */}
          {ready && !isElectron && (
            <RecentProjects
              projects={projects}
              busyId={busyId}
              onOpen={handleOpen}
              onRemove={handleRemove}
            />
          )}

          {!isElectron && <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { icon: Type, title: t("upload.transcribeTitle"), text: t("upload.transcribeText") },
              { icon: Scissors, title: t("upload.editTitle"), text: t("upload.editText") },
              { icon: Clapperboard, title: t("upload.exportTitle"), text: t("upload.exportText") },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-xl border border-zinc-200 bg-white/70 p-4 dark:border-zinc-700 dark:bg-zinc-900/70">
                <Icon size={16} className="mb-2 text-neutral-500 dark:text-neutral-400" />
                <p className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{text}</p>
              </div>
            ))}
          </div>}

          {!isElectron && <div className="mt-6 flex flex-col items-center gap-2">
            <SocialLinks variant="text" />
          </div>}
        </div>
      </div>
    </div>
  );
}
