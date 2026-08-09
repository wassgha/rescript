"use client";

import { useCallback, useEffect, useRef } from "react";
import { isElectron } from "@/lib/platform";
import { deleteProject, listProjects } from "@/lib/projects";
import { useEditorStore } from "@/lib/store";
import type { MenuCommand } from "@/types/rescript-desktop";
import { useI18n } from "@/components/I18nProvider";
import { localizeRuntimeMessage } from "@/lib/i18n";

/**
 * Desktop-only bridge for the native File menu.
 *
 * The recent-project list lives in the renderer's IndexedDB, so the menu can't
 * read it directly: we push a snapshot up whenever it could have changed, and
 * handle the commands the menu sends back (open a file, open/clear recents,
 * leave the editor on an intercepted window close).
 *
 * @param openFilePicker Opens the media picker. Published on `window` because
 *   the main process has to invoke it through executeJavaScript to give the
 *   call the user activation a file chooser requires — over plain IPC Chromium
 *   drops the dialog.
 * @param ready False until the page can accept media (cross-origin isolation).
 *   Opening a project waits rather than getting dropped: the menu can open a
 *   window from scratch, and it lands long before isolation settles.
 */
export function useDesktopMenu(openFilePicker: () => void, ready: boolean): void {
  const { t } = useI18n();
  const projectId = useEditorStore((s) => s.projectId);
  const status = useEditorStore((s) => s.status);

  const syncRecents = useCallback(async () => {
    if (!window.rescriptDesktop) return;
    try {
      const projects = await listProjects();
      window.rescriptDesktop.setRecentProjects(
        projects.map(({ id, name }) => ({ id, name }))
      );
    } catch (err) {
      console.warn("Failed to publish recent projects to the app menu.", err);
    }
  }, []);

  // Re-publish on anything that can add, rename or reorder a project: a new
  // project id (first autosave / open), a status change, or coming back to the
  // window after edits elsewhere.
  useEffect(() => {
    if (!isElectron) return;
    void syncRecents();
    const onFocus = () => void syncRecents();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [syncRecents, projectId, status]);

  const clearRecents = useCallback(async () => {
    if (!confirm(t("confirm.clearRecent"))) return;
    try {
      const projects = await listProjects();
      const active = useEditorStore.getState().projectId;
      await Promise.all(projects.map((p) => deleteProject(p.id)));
      if (active && projects.some((p) => p.id === active)) {
        useEditorStore.getState().reset();
      }
    } catch (err) {
      console.error(err);
      alert(t("error.clearRecent"));
    } finally {
      await syncRecents();
    }
  }, [syncRecents, t]);

  const closeProject = useCallback(async () => {
    // The window stays; only the project goes. Flush the debounced autosave
    // first so the last edits survive the trip back to the upload screen.
    try {
      const { flushProjectAutosave } = await import("@/lib/autosave");
      await flushProjectAutosave();
    } catch (err) {
      console.warn("Failed to save before closing the project.", err);
    }
    useEditorStore.getState().reset();
    await syncRecents();
  }, [syncRecents]);

  // File › Open Project… reaches the picker here rather than over the command
  // channel; see the note on the parameter.
  useEffect(() => {
    if (!isElectron) return;
    window.rescriptOpenFilePicker = openFilePicker;
    return () => {
      delete window.rescriptOpenFilePicker;
    };
  }, [openFilePicker]);

  const run = useCallback(
    (command: MenuCommand) => {
      switch (command.type) {
        case "open-project":
          void useEditorStore
            .getState()
            .openProject(command.id)
            .catch(async (err) => {
              console.error(err);
              alert(
                err instanceof Error
                  ? localizeRuntimeMessage(err.message, t)
                  : t("error.openProject")
              );
              await syncRecents();
            });
          return;
        case "clear-recents":
          void clearRecents();
          return;
        case "close-project":
          void closeProject();
      }
    },
    [clearRecents, closeProject, syncRecents, t]
  );

  // Opening a project can't run before the page is cross-origin isolated; hold
  // the last such command and replay it once it is.
  const deferred = useRef<MenuCommand | null>(null);
  const runRef = useRef(run);
  const readyRef = useRef(ready);
  useEffect(() => {
    runRef.current = run;
    readyRef.current = ready;
  }, [run, ready]);

  useEffect(() => {
    if (!ready || !deferred.current) return;
    const command = deferred.current;
    deferred.current = null;
    runRef.current(command);
  }, [ready]);

  // Subscribed once: the callback reads the latest handlers through refs, so a
  // re-subscribe (which re-announces readiness to the main process) isn't
  // needed every time a dependency changes.
  useEffect(() => {
    const desktop = window.rescriptDesktop;
    if (!desktop) return;
    return desktop.onMenuCommand((command: MenuCommand) => {
      if (command.type === "open-project" && !readyRef.current) {
        deferred.current = command;
        return;
      }
      runRef.current(command);
    });
  }, []);
}
