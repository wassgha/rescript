import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { desktopText as t } from "./locale";

const isMac = process.platform === "darwin";

/** Mirror of the renderer's ProjectMeta, trimmed to what the menu draws. */
export interface RecentProject {
  id: string;
  name: string;
}

/** Anything the menu asks the renderer to do. Mirrored in types/rescript-desktop.d.ts. */
export type MenuCommand =
  | { type: "open-file" }
  | { type: "open-project"; id: string }
  | { type: "clear-recents" }
  /** Leave the editor for the upload screen (a close request, intercepted). */
  | { type: "close-project" };

/** The renderer owns the project list (it lives in IndexedDB); this is the last
 *  snapshot it pushed, kept so the menu can be rebuilt without asking again. */
let recents: RecentProject[] = [];

/** How many entries the "Recent Projects" submenu shows before it gets unwieldy. */
const MAX_RECENT_ITEMS = 10;

/** Set by main.ts — routes a command to a window, opening one if none is left
 *  (the menu stays alive on macOS after the last window closes). */
let dispatch: (command: MenuCommand) => void = () => {};

function send(command: MenuCommand): void {
  dispatch(command);
}

function fileMenu(): MenuItemConstructorOptions {
  const [last] = recents;
  return {
    label: t("file"),
    submenu: [
      {
        label: t("openProject"),
        accelerator: "CmdOrCtrl+O",
        click: () => send({ type: "open-file" }),
      },
      {
        label: t("reopenLast"),
        accelerator: "Shift+CmdOrCtrl+O",
        enabled: last !== undefined,
        click: () => {
          if (last) send({ type: "open-project", id: last.id });
        },
      },
      {
        label: t("recentProjects"),
        submenu:
          recents.length === 0
            ? [{ label: t("noRecent"), enabled: false }]
            : [
                ...recents.slice(0, MAX_RECENT_ITEMS).map((p) => ({
                  label: p.name,
                  click: () => send({ type: "open-project", id: p.id }),
                })),
                { type: "separator" as const },
                {
                  label: t("clearRecent"),
                  click: () => send({ type: "clear-recents" }),
                },
              ],
      },
      { type: "separator" },
      isMac
        ? { role: "close", label: t("close") }
        : { role: "quit", label: t("quit") },
    ],
  };
}

/** Full application menu. Everything outside File is the Electron default —
 *  replacing the menu drops the built-in one wholesale, so it has to be restated. */
function template(): MenuItemConstructorOptions[] {
  return [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about", label: t("about") },
              { type: "separator" },
              { role: "services", label: t("services") },
              { type: "separator" },
              { role: "hide", label: t("hide") },
              { role: "hideOthers", label: t("hideOthers") },
              { role: "unhide", label: t("unhide") },
              { type: "separator" },
              { role: "quit", label: t("quit") },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    fileMenu(),
    {
      label: t("edit"),
      submenu: [
        { role: "undo", label: t("undo") },
        { role: "redo", label: t("redo") },
        { type: "separator" },
        { role: "cut", label: t("cut") },
        { role: "copy", label: t("copy") },
        { role: "paste", label: t("paste") },
        ...(isMac
          ? ([
              { role: "pasteAndMatchStyle", label: t("pasteMatch") },
              { role: "delete", label: t("delete") },
              { role: "selectAll", label: t("selectAll") },
            ] satisfies MenuItemConstructorOptions[])
          : ([
              { role: "delete", label: t("delete") },
              { type: "separator" },
              { role: "selectAll", label: t("selectAll") },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: t("view"),
      submenu: [
        { role: "reload", label: t("reload") },
        { role: "forceReload", label: t("forceReload") },
        { role: "toggleDevTools", label: t("devTools") },
        { type: "separator" },
        { role: "resetZoom", label: t("resetZoom") },
        { role: "zoomIn", label: t("zoomIn") },
        { role: "zoomOut", label: t("zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: t("fullscreen") },
      ],
    },
    {
      label: t("window"),
      submenu: [
        { role: "minimize", label: t("minimize") },
        { role: "zoom", label: t("zoom") },
        ...(isMac
          ? ([
              { type: "separator" },
              { role: "front", label: t("front") },
              { type: "separator" },
              { role: "window", label: t("window") },
            ] satisfies MenuItemConstructorOptions[])
          : ([{ role: "close", label: t("close") }] satisfies MenuItemConstructorOptions[])),
      ],
    },
  ];
}

export function buildAppMenu(
  commandDispatcher?: (command: MenuCommand) => void
): void {
  if (commandDispatcher) dispatch = commandDispatcher;
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
}

/** Replace the recent list and redraw the menu. Called whenever the renderer's
 *  IndexedDB project list changes (open, autosave, delete). */
export function setRecentProjects(next: RecentProject[]): void {
  recents = next;
  buildAppMenu();
}
