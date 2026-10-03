/**
 * Spawning and supervising the bundled native ffmpeg.
 *
 * Deliberately free of `electron` imports so tests can drive it with plain
 * Node (tests/native-ffmpeg-test.ts). The IPC surface lives in ./media.ts.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createProgressParser, type ExportPlan } from "../lib/exportArgs";

/**
 * Why a run didn't produce output.
 *
 * - `unavailable`: the binary is missing, can't execute on this machine, or
 *   crashed in a way that says the build itself is unusable here. The caller
 *   falls back to ffmpeg.wasm.
 * - `failed`: ffmpeg ran and rejected the job (non-zero exit). Falling back
 *   would only fail again, slower, so the error is shown instead.
 * - `cancelled`: we killed it.
 */
export type RunFailure = "unavailable" | "failed" | "cancelled";

export type RunOutcome =
  | { ok: true; stderrTail: string }
  | { ok: false; code: RunFailure; detail: string; stderrTail: string };

export interface RunOptions {
  /** Output timestamp in seconds, from `-progress`. */
  onProgress?: (seconds: number) => void;
  /** Each complete stderr line (ffmpeg's log). */
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
}

/** Encoders / filters the presets in lib/exportArgs.ts use — kept in step with scripts/fetch-ffmpeg.mjs. */
export const REQUIRED_ENCODERS = [
  "libx264",
  "libvpx-vp9",
  "libopus",
  "aac",
  "libmp3lame",
  "pcm_s16le",
];
export const REQUIRED_FILTERS = ["trim", "atrim", "concat", "scale"];

const STDERR_TAIL_BYTES = 64 * 1024;

/** Spawn errors that mean "this binary can't run here", not "this job failed". */
const UNAVAILABLE_SPAWN_ERRORS = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EBADARCH"]);

/** Signals a healthy ffmpeg doesn't die from: a build the CPU or OS can't run. */
const CRASH_SIGNALS = new Set(["SIGILL", "SIGSEGV", "SIGBUS", "SIGTRAP"]);

/** Windows NTSTATUS exit codes for the same: access violation, illegal instruction. */
const WINDOWS_CRASH_CODES = new Set([0xc0000005, 0xc000001d, 0xc0000135, 0xc000007b]);

const OS_DIR: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "mac",
  win32: "win",
  linux: "linux",
};

export function binaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

export interface ResolveOptions {
  packaged: boolean;
  /** `process.resourcesPath` — extraResources land in `<resources>/ffmpeg/`. */
  resourcesPath: string;
  /** Repo root, for dev builds (scripts/fetch-ffmpeg.mjs writes build/ffmpeg/). */
  repoRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Where the ffmpeg binary should be, or null when native media is switched off.
 * `RESCRIPT_FFMPEG_PATH` points at a specific binary; `RESCRIPT_MEDIA_ENGINE=wasm`
 * forces the in-browser engine (both for debugging and support).
 */
export function resolveBinary({
  packaged,
  resourcesPath,
  repoRoot,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
}: ResolveOptions): string | null {
  if (env.RESCRIPT_MEDIA_ENGINE === "wasm") return null;
  if (env.RESCRIPT_FFMPEG_PATH) return env.RESCRIPT_FFMPEG_PATH;
  const name = binaryName(platform);
  if (packaged) return join(resourcesPath, "ffmpeg", name);
  const os = OS_DIR[platform];
  if (!os) return null;
  return join(repoRoot, "build", "ffmpeg", `${os}-${arch}`, name);
}

/** Keeps only the last `limit` characters of everything appended. */
class Tail {
  private text = "";
  constructor(private readonly limit: number) {}
  push(chunk: string) {
    this.text += chunk;
    if (this.text.length > this.limit * 2) this.text = this.text.slice(-this.limit);
  }
  toString() {
    return this.text.slice(-this.limit);
  }
}

function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let pending = "";
  return (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n|\r/);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line) onLine(line);
  };
}

/**
 * Run ffmpeg with `args` (inputs, filters, outputs) and settle once the
 * process has fully exited and released its files.
 *
 * Settles on `close`, not `exit`: on Windows the output handle is only
 * released once the pipes close, and renaming the file before then fails.
 */
export function runFFmpeg(
  bin: string,
  args: string[],
  { onProgress, onStderrLine, signal }: RunOptions = {}
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const stderr = new Tail(STDERR_TAIL_BYTES);
    if (signal?.aborted) {
      resolve({ ok: false, code: "cancelled", detail: "cancelled", stderrTail: "" });
      return;
    }
    let settled = false;
    let cancelled = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    const settle = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const child = spawn(
      bin,
      ["-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:1", ...args],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );

    const onAbort = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    if (onProgress) child.stdout.on("data", createProgressParser(onProgress));
    const splitStderr = onStderrLine ? lineSplitter(onStderrLine) : null;
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
      splitStderr?.(chunk);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // Either the spawn itself failed (then `close` may never fire) or a pipe
      // errored on a live process (then `close` follows and reports the exit).
      spawnError = err;
      if (child.pid === undefined) {
        settle({
          ok: false,
          code: UNAVAILABLE_SPAWN_ERRORS.has(err.code ?? "") ? "unavailable" : "failed",
          detail: `spawn ${err.code ?? "error"}: ${err.message}`,
          stderrTail: stderr.toString(),
        });
      }
    });

    child.on("close", (code, killSignal) => {
      const tail = stderr.toString();
      if (cancelled) {
        settle({ ok: false, code: "cancelled", detail: "cancelled", stderrTail: tail });
      } else if (code === 0) {
        settle({ ok: true, stderrTail: tail });
      } else if (killSignal) {
        settle({
          ok: false,
          code: CRASH_SIGNALS.has(killSignal) ? "unavailable" : "failed",
          detail: `ffmpeg killed by ${killSignal}`,
          stderrTail: tail,
        });
      } else {
        const exit = code ?? -1;
        settle({
          ok: false,
          code: WINDOWS_CRASH_CODES.has(exit >>> 0) ? "unavailable" : "failed",
          detail: spawnError
            ? `ffmpeg exited ${exit} (${spawnError.message})`
            : `ffmpeg exited ${exit}`,
          stderrTail: tail,
        });
      }
    });
  });
}

/**
 * Native export argv for `plan`, reading the filtergraph from `graphPath`.
 *
 * The graph goes in a file: every kept range adds ~130 characters, and a
 * transcript with its filler words removed easily has hundreds of ranges —
 * past Windows' 32K command-line limit at about 250 of them. `-filter_complex_script` is the spelling
 * every bundled build (6.0–7.x) understands.
 */
export function nativeExportArgs(
  input: string,
  graphPath: string,
  plan: ExportPlan,
  out: string
): string[] {
  return [
    "-i", input,
    "-filter_complex_script", graphPath,
    ...plan.streamArgs,
    ...plan.codecArgs,
    // Cheap insurance against "Too many packets buffered" when one stream of
    // a long multi-cut graph runs ahead of the other.
    "-max_muxing_queue_size", "1024",
    "-y", out,
  ];
}

export type ProbeOutcome =
  | { ok: true; version: string }
  | { ok: false; detail: string };

/**
 * Check that `bin` starts and carries everything the export presets need. A
 * build without, say, libvpx would otherwise only fail once someone picks WebM.
 */
export async function probeFFmpeg(bin: string): Promise<ProbeOutcome> {
  const collect = async (flag: string) => {
    const lines: string[] = [];
    const outcome = await runRawFFmpeg(bin, [flag], lines);
    return { outcome, text: lines.join("\n") };
  };
  const version = await collect("-version");
  if (!version.outcome.ok) return { ok: false, detail: version.outcome.detail };
  const encoders = await collect("-encoders");
  const filters = await collect("-filters");
  const has = (text: string, name: string) =>
    new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(text);
  const missing = [
    ...REQUIRED_ENCODERS.filter((n) => !has(encoders.text, n)).map((n) => `encoder ${n}`),
    ...REQUIRED_FILTERS.filter((n) => !has(filters.text, n)).map((n) => `filter ${n}`),
  ];
  if (missing.length > 0) return { ok: false, detail: `missing ${missing.join(", ")}` };
  return { ok: true, version: version.text.split("\n")[0] ?? "" };
}

/** Run an informational command (`-version`, `-encoders`) and capture stdout. */
function runRawFFmpeg(
  bin: string,
  args: string[],
  lines: string[]
): Promise<{ ok: true } | { ok: false; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: { ok: true } | { ok: false; detail: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(bin, ["-hide_banner", ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", lineSplitter((line) => lines.push(line)));
    child.on("error", (err: NodeJS.ErrnoException) => {
      settle({ ok: false, detail: `spawn ${err.code ?? "error"}: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      if (code === 0) settle({ ok: true });
      else settle({ ok: false, detail: `ffmpeg ${args.join(" ")} exited ${signal ?? code}` });
    });
  });
}
