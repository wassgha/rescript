import { app, BrowserWindow, ipcMain, protocol, screen, shell, net } from "electron";
import { join, normalize, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, statSync } from "node:fs";
import { initAutoUpdater } from "./updater";
import { IPC, type SpeechAnalyzerTranscribeRequest } from "./ipc/channels";
import {
  checkSpeechAnalyzer,
  transcribeWithSpeechAnalyzer,
} from "./speechAnalyzer";

const isDev = !app.isPackaged;
const DEV_SERVER_URL = process.env.ELECTRON_START_URL ?? "http://localhost:3000";
const isMac = process.platform === "darwin";

type WindowMode = "compact" | "expanded";

/** The shell has two resting sizes: a small window for the upload screen, and a
 *  roomy one once the editor (transcript + preview + timeline) takes over. */
const WINDOW_SIZES: Record<WindowMode, { width: number; height: number }> = {
  compact: { width: 560, height: 400 },
  expanded: { width: 1080, height: 740 },
};
const MIN_SIZE = { width: 560, height: 400 };

/** Height of the in-page drag strip (`h-12`), used to centre the traffic lights. */
const TITLE_BAR_HEIGHT = 48;
/** macOS traffic light buttons are 12px tall. */
const TRAFFIC_LIGHT_HEIGHT = 12;

/** MIME types for the custom app:// protocol that serves the Next static export. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

// Register before app ready so the scheme can be privileged (fetch, workers,
// SharedArrayBuffer via COOP/COEP headers we attach below).
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function staticRoot(): string {
  // Packaged: next export lives next to the compiled main process under
  // resources/app (asar) or we copy it beside electron-dist.
  return join(__dirname, "..", "out");
}

function resolveStaticPath(urlPath: string): string | null {
  const root = staticRoot();
  let pathname = decodeURIComponent(urlPath);
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  // Strip leading slash and normalize; reject path escape attempts.
  const rel = normalize(pathname.replace(/^\/+/, ""));
  if (rel.startsWith("..")) return null;
  let filePath = join(root, rel);
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
  return filePath;
}

function registerAppProtocol(): void {
  protocol.handle("app", async (request) => {
    const { pathname } = new URL(request.url);
    const filePath = resolveStaticPath(pathname);
    if (!filePath) {
      return new Response("Not found", { status: 404, statusText: "Not Found" });
    }
    const fileUrl = pathToFileURL(filePath).toString();
    const response = await net.fetch(fileUrl);
    const headers = new Headers(response.headers);
    // Enable SharedArrayBuffer for ffmpeg.wasm + onnxruntime (same as Next
    // headers() in next.config.ts for the non-export server).
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    const type = MIME[extname(filePath).toLowerCase()];
    if (type) headers.set("Content-Type", type);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}

/** Tracks each window's current mode so repeated requests are no-ops. */
const windowModes = new WeakMap<BrowserWindow, WindowMode>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Resize a window to the given mode's resting size, keeping it centred on
 *  wherever the user left it rather than snapping to a corner. */
function applyWindowMode(win: BrowserWindow, mode: WindowMode): void {
  if (windowModes.get(win) === mode) return;
  windowModes.set(win, mode);
  // A maximized or full-screen window is already the size the user asked for.
  if (win.isFullScreen() || win.isMaximized()) return;

  const current = win.getBounds();
  const { workArea } = screen.getDisplayMatching(current);
  const width = Math.min(WINDOW_SIZES[mode].width, workArea.width);
  const height = Math.min(WINDOW_SIZES[mode].height, workArea.height);
  win.setBounds(
    {
      width,
      height,
      x: Math.round(
        clamp(
          current.x + (current.width - width) / 2,
          workArea.x,
          workArea.x + workArea.width - width
        )
      ),
      y: Math.round(
        clamp(
          current.y + (current.height - height) / 2,
          workArea.y,
          workArea.y + workArea.height - height
        )
      ),
    },
    true // animate (macOS)
  );
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...WINDOW_SIZES.compact,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    backgroundColor: "#fafafa",
    title: "Rescript",
    show: false,
    // macOS: drop the native title bar and let the page's top bar / upload drag
    // strip move the window instead. Windows and Linux keep their native frame
    // — hiding it there would take the caption buttons with it.
    ...(isMac
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: {
            x: 16,
            y: Math.round((TITLE_BAR_HEIGHT - TRAFFIC_LIGHT_HEIGHT) / 2),
          },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  windowModes.set(win, "compact");

  win.once("ready-to-show", () => win.show());

  // The page pads its top bar for the traffic lights, which macOS hides in
  // full screen; tell it when that changes so the gap can collapse.
  const emitFullScreen = () => {
    if (!win.isDestroyed()) {
      win.webContents.send("window:full-screen-changed", win.isFullScreen());
    }
  };
  win.on("enter-full-screen", emitFullScreen);
  win.on("leave-full-screen", emitFullScreen);

  // Open external http(s) links in the OS browser; keep app:// / localhost in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const isApp = url.startsWith("app://");
    const isDevServer = isDev && url.startsWith(DEV_SERVER_URL);
    if (!isApp && !isDevServer) {
      event.preventDefault();
      if (url.startsWith("http:") || url.startsWith("https:")) {
        void shell.openExternal(url);
      }
    }
  });

  if (isDev) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadURL("app://localhost/");
  }

  return win;
}

// Ensure a single instance — second launches focus the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  ipcMain.on("window:set-mode", (event, mode: unknown) => {
    if (mode !== "compact" && mode !== "expanded") return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) applyWindowMode(win, mode);
  });
  ipcMain.handle(
    "window:is-full-screen",
    (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false
  );

  app.whenReady().then(() => {
    if (!isDev) registerAppProtocol();

    ipcMain.handle(IPC.speechAnalyzerCheck, async () => checkSpeechAnalyzer());
    ipcMain.handle(
      IPC.speechAnalyzerTranscribe,
      async (event, req: SpeechAnalyzerTranscribeRequest) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return transcribeWithSpeechAnalyzer(req, (progress) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send(IPC.speechAnalyzerProgress, progress);
          }
        });
      }
    );

    createWindow();
    initAutoUpdater();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
