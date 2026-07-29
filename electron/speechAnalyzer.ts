import { app } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type {
  SpeechAnalyzerCheckResult,
  SpeechAnalyzerProgress,
  SpeechAnalyzerTranscribeRequest,
  SpeechAnalyzerTranscribeResult,
  SpeechAnalyzerWord,
} from "./ipc/channels";

const HELPER_NAME = "rescript-speechanalyzer";

/**
 * Resolve the SpeechAnalyzer helper binary. Packaged builds look under
 * process.resourcesPath/bin; dev looks at resources/bin then the Swift
 * build product under native/speechanalyzer/.build/release.
 */
export function resolveHelperPath(): string | null {
  const candidates: string[] = [];
  if (app.isPackaged) {
    candidates.push(join(process.resourcesPath, "bin", HELPER_NAME));
  } else {
    const root = join(__dirname, "..");
    candidates.push(
      join(root, "resources", "bin", HELPER_NAME),
      join(root, "native", "speechanalyzer", ".build", "release", HELPER_NAME)
    );
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

function runHelper(
  args: string[],
  onProgress?: (p: SpeechAnalyzerProgress) => void
): Promise<{ code: number; stdout: string; stderr: string }> {
  const helper = resolveHelperPath();
  if (!helper) {
    return Promise.reject(
      new Error(
        "SpeechAnalyzer helper not found. On macOS 26+, build it with `make -C native/speechanalyzer build`."
      )
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (buf: Buffer) => {
      stdout += buf.toString("utf8");
    });
    child.stderr.on("data", (buf: Buffer) => {
      const chunk = buf.toString("utf8");
      stderr += chunk;
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const msg = JSON.parse(trimmed) as {
            type?: string;
            message?: string;
            value?: number | null;
          };
          if (msg.type === "progress" && onProgress) {
            onProgress({
              message: msg.message ?? "Transcribing…",
              value: typeof msg.value === "number" ? msg.value : null,
            });
          }
        } catch {
          // ignore non-JSON stderr
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseLastJson(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) throw new Error("SpeechAnalyzer helper produced no output.");
  return JSON.parse(last) as Record<string, unknown>;
}

export async function checkSpeechAnalyzer(): Promise<SpeechAnalyzerCheckResult> {
  if (process.platform !== "darwin") {
    return {
      available: false,
      reason: "SpeechAnalyzer is only available on macOS.",
      helperPath: null,
    };
  }
  const helperPath = resolveHelperPath();
  if (!helperPath) {
    return {
      available: false,
      reason:
        "SpeechAnalyzer helper is not built yet. Run `make -C native/speechanalyzer build` on macOS 26+.",
      helperPath: null,
    };
  }
  try {
    const { code, stdout } = await runHelper(["--check"]);
    const payload = parseLastJson(stdout);
    if (payload.type === "error") {
      return {
        available: false,
        reason: String(payload.message ?? "SpeechAnalyzer check failed."),
        helperPath,
      };
    }
    return {
      available: Boolean(payload.available) && code === 0,
      reason: payload.reason ? String(payload.reason) : undefined,
      locale: payload.locale ? String(payload.locale) : undefined,
      installedLocales: Array.isArray(payload.installedLocales)
        ? (payload.installedLocales as string[])
        : undefined,
      helperPath,
    };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      helperPath,
    };
  }
}

function normalizeWords(raw: unknown): SpeechAnalyzerWord[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    const w = (item ?? {}) as Record<string, unknown>;
    const text = String(w.text ?? "").trim();
    const start = Number(w.start) || 0;
    const end = Math.max(Number(w.end) || 0, start);
    return {
      id: typeof w.id === "number" ? w.id : i,
      text,
      start,
      end,
      speaker: typeof w.speaker === "number" ? w.speaker : 0,
      deleted: Boolean(w.deleted),
    };
  }).filter((w) => w.text.length > 0);
}

async function materializePath(
  req: SpeechAnalyzerTranscribeRequest
): Promise<{ path: string; cleanup?: string }> {
  if (req.path) {
    if (!existsSync(req.path)) {
      throw new Error(`Media file not found: ${req.path}`);
    }
    return { path: req.path };
  }
  if (!req.data) {
    throw new Error("SpeechAnalyzer needs a file path or raw media bytes.");
  }
  const dir = join(tmpdir(), "rescript-speechanalyzer");
  mkdirSync(dir, { recursive: true });
  const ext = (req.name?.split(".").pop() || "bin").replace(/[^a-z0-9]/gi, "") || "bin";
  const tempPath = join(dir, `${randomUUID()}.${ext}`);
  writeFileSync(tempPath, Buffer.from(req.data));
  return { path: tempPath, cleanup: tempPath };
}

export async function transcribeWithSpeechAnalyzer(
  req: SpeechAnalyzerTranscribeRequest,
  onProgress?: (p: SpeechAnalyzerProgress) => void
): Promise<SpeechAnalyzerTranscribeResult> {
  if (process.platform !== "darwin") {
    throw new Error("SpeechAnalyzer is only available on macOS.");
  }
  const { path, cleanup } = await materializePath(req);
  try {
    const args = [path];
    if (req.locale) args.push("--locale", req.locale);
    const { code, stdout } = await runHelper(args, onProgress);
    const payload = parseLastJson(stdout);
    if (payload.type === "error" || code !== 0) {
      throw new Error(String(payload.message ?? `SpeechAnalyzer exited with code ${code}`));
    }
    const words = normalizeWords(payload.words);
    if (words.length === 0) {
      throw new Error("SpeechAnalyzer returned no words.");
    }
    // Re-index ids contiguously for the editor.
    const reindexed = words.map((w, i) => ({ ...w, id: i }));
    return {
      words: reindexed,
      locale: String(payload.locale ?? "und"),
      duration: Number(payload.duration) || 0,
      model: String(payload.model ?? "SpeechAnalyzer/macOS26"),
    };
  } finally {
    if (cleanup) {
      try {
        unlinkSync(cleanup);
      } catch {
        // temp cleanup is best-effort
      }
    }
  }
}
