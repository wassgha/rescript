"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  AudioLines,
  Clapperboard,
  Film,
  Loader2,
  Lock,
  Music,
  Scissors,
  ShieldAlert,
  Trash2,
  Type,
} from "lucide-react";
import logo from "@/assets/logo.png";
import GitHubLink from "./GitHubLink";
import ModelSelector from "./ModelSelector";
import TranscriptSourceOptions from "./TranscriptSourceOptions";
import { useCrossOriginIsolated } from "@/hooks/useCrossOriginIsolated";
import { detectMediaKind, MEDIA_ACCEPT } from "@/lib/media";
import { formatTime } from "@/lib/edits";
import {
  formatRelativeTime,
  listProjects,
  type ProjectMeta,
} from "@/lib/projects";
import { useEditorStore } from "@/lib/store";
import type { Word } from "@/lib/types";

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
          className={`absolute flex flex-col items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white transition-transform duration-300 ease-out ${size} ${dragging ? fan : rest
            }`}
        >
          <Icon size={iconSize} className="text-neutral-400" />
          <div className="flex flex-col items-center gap-1">
            {bars.map((w) => (
              <span key={w} className={`block h-[3px] rounded-full bg-zinc-200 ${w}`} />
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
  if (projects.length === 0) return null;
  return (
    <div className="mt-6">
      <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400">
        Recent
      </p>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white/80">
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
                  className="flex cursor-pointer min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition hover:bg-zinc-50 disabled:opacity-60"
                >
                  <KindIcon size={16} className="shrink-0 text-zinc-400 mx-2" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-zinc-800">
                      {p.name}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-zinc-400">
                      {formatRelativeTime(p.updatedAt)}
                      {p.duration > 0 ? ` · ${formatTime(p.duration)}` : ""}
                      {` · ${p.mediaKind}`}
                    </span>
                  </span>
                  {opening && (
                    <Loader2 size={14} className="shrink-0 animate-spin text-zinc-400" />
                  )}
                </button>
                <button
                  type="button"
                  title="Remove from recent"
                  disabled={busyId !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(p.id);
                  }}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40"
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
  onFile: (file: File, options?: { words?: Word[] }) => void;
}) {
  const isElectron = /electron/i.test(navigator.userAgent);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The pipeline needs SharedArrayBuffer, which on static hosts only appears
  // after the COI service worker reloads the page. Accepting a file before then
  // would fail immediately and lose the file to that reload.
  const isolation = useCrossOriginIsolated();
  const ready = isolation === "ready";
  const model = useEditorStore((s) => s.model);
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  const openProject = useEditorStore((s) => s.openProject);
  const removeProject = useEditorStore((s) => s.removeProject);

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
        alert("Please choose a video or audio file.");
        return;
      }
      const { model: source, pendingTranscript: pending } =
        useEditorStore.getState();
      if (source === "import") {
        if (!pending) {
          alert("Choose a transcript file from the source menu first.");
          return;
        }
        onFile(file, { words: pending.words });
        return;
      }
      onFile(file);
    },
    [onFile, ready]
  );

  const handleOpen = useCallback(
    async (id: string) => {
      if (!ready) return;
      setBusyId(id);
      try {
        await openProject(id);
      } catch (err) {
        console.error(err);
        alert(err instanceof Error ? err.message : "Could not open that project.");
        await refreshProjects();
      } finally {
        setBusyId(null);
      }
    },
    [openProject, ready, refreshProjects]
  );

  const handleRemove = useCallback(
    async (id: string) => {
      try {
        await removeProject(id);
        await refreshProjects();
      } catch (err) {
        console.error(err);
        alert("Could not remove that project.");
      }
    },
    [removeProject, refreshProjects]
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-gradient-to-b from-zinc-50 to-neutral-50/50">
      {/* min-h-full + items-center centers when content fits; the outer
          overflow-y-auto still lets short viewports (mobile) scroll the top. */}
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="w-full max-w-xl">
          {!isElectron && <div className="mb-6 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center">
              <Image
                src={logo}
                alt="Rescript"
                width={24}
                height={24}
                priority
                className="rounded-sm border border-zinc-200"
              />
              <p className="ml-2 text-[15px] font-medium text-zinc-800">Rescript</p>
            </div>
            <ModelSelector groupLabel="Transcript source">
              <TranscriptSourceOptions />
            </ModelSelector>
          </div>}
          <div
            role="button"
            aria-disabled={!ready}
            tabIndex={ready ? 0 : -1}
            onClick={() => ready && inputRef.current?.click()}
            onKeyDown={(e) => ready && e.key === "Enter" && inputRef.current?.click()}
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
            className={`group flex flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-white/80 px-8 py-14 text-center transition ${!ready
                ? "cursor-default border-zinc-200"
                : dragging
                  ? "cursor-pointer border-neutral-500 bg-neutral-50/80"
                  : "cursor-pointer border-zinc-300 hover:border-neutral-400 hover:bg-white"
              }`}
          >
            {ready ? (
              <MediaCards dragging={dragging} />
            ) : (
              <div
                className={`mb-3 flex h-12 w-12 items-center justify-center rounded-full ${isolation === "unavailable"
                    ? "bg-amber-50 text-amber-600"
                    : "bg-neutral-100 text-neutral-600"
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
                <p className="text-[15px] font-medium text-zinc-800">
                  This browser can&apos;t run the editor
                </p>
                <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-zinc-400">
                  Editing needs SharedArrayBuffer, which requires a cross-origin-isolated page.
                  Try a recent Chrome, Edge or Firefox over HTTPS.
                </p>
              </>
            ) : ready ? (
              <>
                <p className="text-[15px] font-medium text-zinc-800">
                  Drop a video or audio file here, or{" "}
                  <span className="text-neutral-600">browse</span>
                </p>
                <p className="mt-1 text-[13px] text-zinc-400">
                  {model === "import"
                    ? pendingTranscript
                      ? `Will use ${pendingTranscript.name} · MP4, WebM, MOV, MP3, WAV, …`
                      : "Pick a transcript in the menu above, then drop your media"
                    : model === "speechanalyzer"
                      ? "Transcribes on-device with Apple SpeechAnalyzer · MP4, WebM, MOV, MP3, WAV, …"
                      : "MP4, WebM, MOV, MP3, WAV, M4A, …"}
                </p>
              </>
            ) : (
              <>
                <p className="text-[15px] font-medium text-zinc-800">Getting things ready</p>
                <p className="mt-1 text-[13px] text-zinc-400">
                  Setting up the media engine, this only happens once.
                </p>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept={MEDIA_ACCEPT}
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>

          {ready && (
            <RecentProjects
              projects={projects}
              busyId={busyId}
              onOpen={handleOpen}
              onRemove={handleRemove}
            />
          )}

          {!isElectron && <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { icon: Type, title: "Transcribe", text: "Whisper locally, or import SRT / VTT." },
              { icon: Scissors, title: "Edit", text: "Select words and hit delete to edit." },
              { icon: Clapperboard, title: "Export", text: "Render the final cut to MP4 or M4A." },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-xl border border-zinc-200 bg-white/70 p-4">
                <Icon size={16} className="mb-2 text-neutral-500" />
                <p className="text-[13px] font-semibold text-zinc-800">{title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{text}</p>
              </div>
            ))}
          </div>}

          {!isElectron && <div className="mt-6 flex flex-col items-center gap-2">
            <p className="flex items-center justify-center gap-1.5 text-center text-xs text-zinc-400">
              <Lock size={12} />
              No uploads, no accounts — your media never leaves this device.
            </p>
            <GitHubLink variant="text" />
          </div>}
        </div>
      </div>
    </div>
  );
}
