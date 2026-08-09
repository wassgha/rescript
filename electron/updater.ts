import { app, BrowserWindow, dialog } from "electron";
import log from "electron-log";
import { autoUpdater } from "electron-updater";
import { desktopText as t } from "./locale";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * Wire up auto-updates against GitHub Releases (provider configured in
 * package.json `build.publish`). electron-updater reads the `latest-*.yml`
 * manifests published alongside the installers — no separate update server.
 *
 * Only runs in packaged builds; dev launches never check for updates.
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.logger = log;
  log.transports.file.level = "info";
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    log.error("[updater] error", err);
  });
  autoUpdater.on("checking-for-update", () => {
    log.info("[updater] checking for update");
  });
  autoUpdater.on("update-available", (info) => {
    log.info("[updater] update available", info.version);
  });
  autoUpdater.on("update-not-available", () => {
    log.info("[updater] up to date");
  });
  autoUpdater.on("download-progress", (progress) => {
    log.info("[updater] download progress", Math.round(progress.percent));
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info("[updater] update downloaded", info.version);
    const opts = {
      type: "info" as const,
      buttons: [t("restart"), t("later")],
      defaultId: 0,
      cancelId: 1,
      title: t("updateTitle"),
      message: t("updateMessage", { version: info.version }),
      detail: t("updateDetail"),
    };
    const win = BrowserWindow.getFocusedWindow();
    void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(
      ({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      }
    );
  });

  void autoUpdater.checkForUpdates();
  setInterval(() => {
    void autoUpdater.checkForUpdates();
  }, CHECK_INTERVAL_MS);
}
