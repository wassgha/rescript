export type DesktopLocale = "en" | "zh-CN";

let currentLocale: DesktopLocale = "en";

const en = {
  file: "File",
  openProject: "Open Project…",
  reopenLast: "Reopen Last Project",
  recentProjects: "Recent Projects",
  noRecent: "No Recent Projects",
  clearRecent: "Clear Recent Projects",
  edit: "Edit",
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  pasteMatch: "Paste and Match Style",
  delete: "Delete",
  selectAll: "Select All",
  view: "View",
  reload: "Reload",
  forceReload: "Force Reload",
  devTools: "Toggle Developer Tools",
  resetZoom: "Actual Size",
  zoomIn: "Zoom In",
  zoomOut: "Zoom Out",
  fullscreen: "Toggle Full Screen",
  window: "Window",
  minimize: "Minimize",
  zoom: "Zoom",
  front: "Bring All to Front",
  close: "Close Window",
  quit: "Quit Rescript",
  about: "About Rescript",
  services: "Services",
  hide: "Hide Rescript",
  hideOthers: "Hide Others",
  unhide: "Show All",
  restart: "Restart",
  later: "Later",
  updateTitle: "Update available",
  updateMessage: "Rescript {version} is ready to install.",
  updateDetail: "Restart now to apply the update.",
} as const;

type DesktopMessageKey = keyof typeof en;

const zhCN: Record<DesktopMessageKey, string> = {
  file: "文件",
  openProject: "打开项目…",
  reopenLast: "重新打开上一个项目",
  recentProjects: "最近项目",
  noRecent: "没有最近项目",
  clearRecent: "清除最近项目",
  edit: "编辑",
  undo: "撤销",
  redo: "重做",
  cut: "剪切",
  copy: "复制",
  paste: "粘贴",
  pasteMatch: "粘贴并匹配样式",
  delete: "删除",
  selectAll: "全选",
  view: "视图",
  reload: "重新加载",
  forceReload: "强制重新加载",
  devTools: "切换开发者工具",
  resetZoom: "实际大小",
  zoomIn: "放大",
  zoomOut: "缩小",
  fullscreen: "切换全屏",
  window: "窗口",
  minimize: "最小化",
  zoom: "缩放",
  front: "前置全部窗口",
  close: "关闭窗口",
  quit: "退出 Rescript",
  about: "关于 Rescript",
  services: "服务",
  hide: "隐藏 Rescript",
  hideOthers: "隐藏其他应用",
  unhide: "全部显示",
  restart: "立即重启",
  later: "稍后",
  updateTitle: "有可用更新",
  updateMessage: "Rescript {version} 已准备好安装。",
  updateDetail: "立即重启以应用更新。",
};

export function resolveDesktopLocale(value: string): DesktopLocale {
  const locale = value.toLowerCase();
  return locale === "zh" || locale.startsWith("zh-") ? "zh-CN" : "en";
}

export function setDesktopLocale(locale: DesktopLocale): void {
  currentLocale = locale;
}

export function desktopText(
  key: DesktopMessageKey,
  params: Record<string, string | number> = {}
): string {
  const template = (currentLocale === "zh-CN" ? zhCN : en)[key];
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token
  );
}
