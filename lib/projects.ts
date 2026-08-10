/**
 * IndexedDB persistence for Rescript projects.
 *
 * Stores the original media blob + transcript words so a refresh can restore
 * the editor without re-uploading or re-transcribing. Caps at MAX_PROJECTS
 * (oldest by updatedAt are pruned).
 */

import { isTranscriptSource, type TranscriptSource } from "./source";
import type { TranscriptLanguagePreference } from "./languages";
import {
  DEFAULT_TRANSCRIPT_LANGUAGE,
  isTranscriptLanguagePreference,
} from "./languages";
import type { MediaKind } from "./media";
import type { ManualCut, SceneBoundary, SpeakerInfo, Word } from "./types";

const DB_NAME = "rescript-projects";
const DB_VERSION = 1;
const STORE = "projects";
export const MAX_PROJECTS = 10;

export interface ProjectMeta {
  id: string;
  name: string;
  mediaKind: MediaKind;
  duration: number;
  source: TranscriptSource;
  transcriptLanguage: TranscriptLanguagePreference;
  updatedAt: number;
  createdAt: number;
}

/** Read source from a stored row; older saves used `model`. */
function projectSource(row: {
  source?: unknown;
  model?: unknown;
}): TranscriptSource {
  const raw = row.source ?? row.model;
  return isTranscriptSource(raw) ? raw : "base";
}

export interface ProjectRecord extends ProjectMeta {
  words: Word[];
  showDeleted: boolean;
  /** Blade/trim cuts not owned by deleted words (optional for older saves). */
  manualCuts?: ManualCut[];
  /** Scene split points in original media time (optional for older saves). */
  sceneBoundaries?: SceneBoundary[];
  /** Named speakers (optional for older saves — derived from words when missing). */
  speakers?: SpeakerInfo[];
  /** Original media bytes. */
  media: Blob;
  /** MIME type used when reconstructing a File. */
  mediaType: string;
}

export type ProjectWrite = Omit<ProjectRecord, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
  createdAt?: number;
};

// One shared connection for the page. Opening (and closing) a fresh one per
// call churned connections — every autosave paid an open handshake, and DevTools
// lists the database once per open, which looks like duplicate stores.
let dbPromise: Promise<IDBDatabase> | null = null;
let liveDb: IDBDatabase | null = null;

/** Drop the cached handle so the next call reopens. */
function forgetDb(db: IDBDatabase) {
  if (liveDb !== db) return;
  liveDb = null;
  dbPromise = null;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      liveDb = db;
      // A held-open connection blocks another tab's upgrade, and the browser can
      // force-close it when reclaiming storage — invalidate the cache for both.
      db.onversionchange = () => {
        db.close();
        forgetDb(db);
      };
      db.onclose = () => forgetDb(db);
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("Failed to open projects DB."));
    };
  });
  return dbPromise;
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed."));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
  });
}

/** List projects newest-first (metadata only — no media/words payloads). */
export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const rows = await idbReq(store.getAll() as IDBRequest<ProjectRecord[]>);
  await txDone(tx);
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      mediaKind: r.mediaKind,
      duration: r.duration,
      source: projectSource(r),
      transcriptLanguage: isTranscriptLanguagePreference(r.transcriptLanguage)
        ? r.transcriptLanguage
        : DEFAULT_TRANSCRIPT_LANGUAGE,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const row = await idbReq(
    tx.objectStore(STORE).get(id) as IDBRequest<
      (ProjectRecord & { model?: unknown }) | undefined
    >
  );
  await txDone(tx);
  if (!row) return null;
  return { ...row, source: projectSource(row) };
}

/** Insert or replace a project, then prune to MAX_PROJECTS. Returns the id. */
export async function putProject(input: ProjectWrite): Promise<string> {
  const now = Date.now();
  const id = input.id ?? crypto.randomUUID();
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);

  // Read createdAt back in the same transaction as the write, so overlapping
  // saves can't interleave and lose it (and so a save is a single transaction).
  let createdAt = input.createdAt;
  if (createdAt === undefined && input.id !== undefined) {
    const existing = await idbReq(store.get(id) as IDBRequest<ProjectRecord | undefined>);
    createdAt = existing?.createdAt;
  }

  const record: ProjectRecord = {
    id,
    name: input.name,
    mediaKind: input.mediaKind,
    duration: input.duration,
    source: isTranscriptSource(input.source) ? input.source : "base",
    transcriptLanguage: isTranscriptLanguagePreference(input.transcriptLanguage)
      ? input.transcriptLanguage
      : DEFAULT_TRANSCRIPT_LANGUAGE,
    words: input.words,
    showDeleted: input.showDeleted,
    manualCuts: input.manualCuts ?? [],
    sceneBoundaries: input.sceneBoundaries ?? [],
    speakers: input.speakers ?? [],
    media: input.media,
    mediaType: input.mediaType,
    createdAt: createdAt ?? now,
    updatedAt: now,
  };

  store.put(record);

  // Prune oldest beyond the cap (never delete the record we just wrote). The
  // updatedAt index yields primary keys oldest-first, so pruning doesn't have to
  // deserialize every stored media blob the way getAll() would.
  const keys = await idbReq(
    store.index("updatedAt").getAllKeys() as IDBRequest<IDBValidKey[]>
  );
  let excess = keys.length - MAX_PROJECTS;
  for (const key of keys) {
    if (excess <= 0) break;
    if (key === id) continue;
    store.delete(key);
    excess--;
  }

  await txDone(tx);
  return id;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
}

/** Reconstruct a File from a stored project for preview/export. */
export function fileFromProject(project: ProjectRecord): File {
  return new File([project.media], project.name, {
    type: project.mediaType || project.media.type || undefined,
    lastModified: project.updatedAt,
  });
}

/** Compact relative time for the recent list (e.g. "just now", "3h ago"). */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
