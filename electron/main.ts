import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  screen,
  shell,
  net,
  type WebContents,
} from "electron";
import { join, normalize, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { initMainSentry, setMainTelemetryEnabled } from "./sentry";
import { initAutoUpdater } from "./updater";
import {
  buildAppMenu,
  setRecentProjects,
  type MenuCommand,
  type RecentProject,
} from "./menu";

const isDev = !app.isPackaged;
const DEV_SERVER_URL = process.env.ELECTRON_START_URL ?? "http://localhost:3000";
const isMac = process.platform === "darwin";

type WindowMode = "compact" | "expanded";

/** Start roomy enough for the three-pane editor; subsequent launches restore
 *  the user's own normal bounds instead of forcing upload/editor sizes. */
const DEFAULT_WINDOW_SIZE = { width: 1280, height: 820 };
const MIN_SIZE = { width: 720, height: 480 };
const WINDOW_STATE_FILE = "window-state.json";

type StoredWindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
};

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

// At module scope, before `app.whenReady()`: a crash while registering the
// protocol or resolving the static root happens before any window exists, and
// those are precisely the failures nothing else can report.
//
// This must also come *before* our own registerSchemesAsPrivileged call below.
// Electron's registerSchemesAsPrivileged replaces the scheme list rather than
// appending to it, and Sentry registers its own `sentry-ipc` scheme during
// init, then proxies the function so *later* calls merge its scheme back in.
// Registering `app` first therefore gets it silently overwritten, and the
// renderer's fetch() of app:// URLs fails with `URL scheme "app" is not
// supported` — which is how ffmpeg.wasm's core fails to load.
initMainSentry();

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
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
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

/** Renderers that have mounted and subscribed to menu commands. A freshly
 *  created (or reloading) window isn't listening yet, so its commands wait. */
const readyRenderers = new WeakSet<WebContents>();
const pendingCommands = new WeakMap<WebContents, MenuCommand[]>();

function deliverMenuCommand(contents: WebContents, command: MenuCommand): void {
  if (command.type === "open-file") {
    // Chromium only opens a file chooser under user activation, which an IPC
    // message doesn't carry — the click() is silently dropped. executeJavaScript
    // can grant one, so the picker is driven that way instead.
    void contents
      .executeJavaScript("window.rescriptOpenFilePicker?.()", true)
      .catch((err: unknown) => console.error("Failed to open the file picker.", err));
    return;
  }
  contents.send("menu:command", command);
}

function flushPendingCommands(contents: WebContents): void {
  const queued = pendingCommands.get(contents);
  pendingCommands.delete(contents);
  for (const command of queued ?? []) deliverMenuCommand(contents, command);
}

/** Deliver a File-menu command, launching a window if the app is running
 *  window-less (macOS keeps the menu bar after the last window closes). */
function dispatchMenuCommand(command: MenuCommand): void {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? createWindow();
  const contents = win.webContents;
  if (readyRenderers.has(contents)) {
    deliverMenuCommand(contents, command);
    return;
  }
  const queued = pendingCommands.get(contents) ?? [];
  queued.push(command);
  pendingCommands.set(contents, queued);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isStoredWindowState(value: unknown): value is StoredWindowState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<StoredWindowState>;
  return (
    [state.x, state.y, state.width, state.height].every(Number.isFinite) &&
    typeof state.maximized === "boolean"
  );
}

/** Restore saved bounds onto the closest current display. This also recovers
 *  from a monitor being disconnected between launches. */
function loadWindowState(): StoredWindowState {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const fallbackWidth = Math.min(DEFAULT_WINDOW_SIZE.width, primaryWorkArea.width);
  const fallbackHeight = Math.min(DEFAULT_WINDOW_SIZE.height, primaryWorkArea.height);
  const fallback: StoredWindowState = {
    width: fallbackWidth,
    height: fallbackHeight,
    x: Math.round(primaryWorkArea.x + (primaryWorkArea.width - fallbackWidth) / 2),
    y: Math.round(primaryWorkArea.y + (primaryWorkArea.height - fallbackHeight) / 2),
    maximized: false,
  };

  const statePath = join(app.getPath("userData"), WINDOW_STATE_FILE);
  if (!existsSync(statePath)) return fallback;
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    if (!isStoredWindowState(parsed)) return fallback;
    const workArea = screen.getDisplayMatching(parsed).workArea;
    const width = Math.min(Math.max(Math.round(parsed.width), MIN_SIZE.width), workArea.width);
    const height = Math.min(
      Math.max(Math.round(parsed.height), MIN_SIZE.height),
      workArea.height
    );
    return {
      width,
      height,
      x: Math.round(clamp(parsed.x, workArea.x, workArea.x + workArea.width - width)),
      y: Math.round(clamp(parsed.y, workArea.y, workArea.y + workArea.height - height)),
      maximized: parsed.maximized,
    };
  } catch (error) {
    console.warn("Could not restore the saved window bounds.", error);
    return fallback;
  }
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const bounds = win.getNormalBounds();
  const state: StoredWindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized(),
  };
  try {
    writeFileSync(
      join(app.getPath("userData"), WINDOW_STATE_FILE),
      JSON.stringify(state),
      "utf8"
    );
  } catch (error) {
    console.warn("Could not save the window bounds.", error);
  }
}

/** Set once the app is really terminating, so the close interception below
 *  doesn't swallow the quit. */
let quitting = false;

function createWindow(): BrowserWindow {
  const restoredState = loadWindowState();
  const win = new BrowserWindow({
    x: restoredState.x,
    y: restoredState.y,
    width: restoredState.width,
    height: restoredState.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    // Light by default — appearance is a user preference in the renderer.
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

  win.once("ready-to-show", () => {
    if (restoredState.maximized) win.maximize();
    win.show();
  });

  let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleWindowStateSave = () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      saveBoundsTimer = null;
      saveWindowState(win);
    }, 250);
  };
  win.on("resize", scheduleWindowStateSave);
  win.on("move", scheduleWindowStateSave);
  win.on("maximize", scheduleWindowStateSave);
  win.on("unmaximize", scheduleWindowStateSave);
  win.on("closed", () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  });

  // A reload tears down the listener the renderer registered; make it re-announce.
  win.webContents.on("did-start-navigation", (event) => {
    if (event.isSameDocument) return;
    readyRenderers.delete(win.webContents);
    pendingCommands.delete(win.webContents);
  });

  // Closing while the editor is open drops the project rather than the window:
  // the renderer returns to the upload screen and the shell shrinks back. The
  // next close (already on the upload screen) is a real close. Guarded on the
  // renderer being live, so an unresponsive page can still be closed.
  win.on("close", (event) => {
    saveWindowState(win);
    if (quitting) return;
    if (windowModes.get(win) !== "expanded") return;
    if (!readyRenderers.has(win.webContents)) return;
    event.preventDefault();
    win.webContents.send("menu:command", { type: "close-project" } satisfies MenuCommand);
  });

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
    if (win) windowModes.set(win, mode);
  });
  ipcMain.handle(
    "window:is-full-screen",
    (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false
  );
  // The renderer owns the preference; this mirrors it so the next launch can gate
  // reporting before any window exists.
  ipcMain.on("telemetry:set-enabled", (_event, value: unknown) => {
    setMainTelemetryEnabled(value === true);
  });
  // The saved projects live in the renderer's IndexedDB; it pushes a snapshot
  // whenever the list changes so the File menu can list them.
  ipcMain.on("menu:set-recents", (_event, value: unknown) => {
    if (!Array.isArray(value)) return;
    const recents: RecentProject[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const { id, name } = entry as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || typeof name !== "string") continue;
      recents.push({ id, name });
    }
    setRecentProjects(recents);
  });
  // The renderer announces itself once it is listening for menu commands; until
  // then anything the menu fired at a just-opened window is held.
  ipcMain.on("menu:renderer-ready", (event) => {
    readyRenderers.add(event.sender);
    flushPendingCommands(event.sender);
  });

  app.on("before-quit", () => {
    quitting = true;
  });

  app.whenReady().then(() => {
    if (!isDev) registerAppProtocol();
    buildAppMenu(dispatchMenuCommand);
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
