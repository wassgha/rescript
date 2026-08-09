import {
  formatRelativeTime,
  localizeRuntimeMessage,
  resolveUiLocale,
  translate,
} from "../lib/i18n";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

assert(resolveUiLocale("system", ["zh-CN"]) === "zh-CN", "zh-CN detection");
assert(resolveUiLocale("system", ["zh-HK"]) === "zh-CN", "zh-HK fallback");
assert(resolveUiLocale("system", ["fr-FR", "en-US"]) === "en", "ordered fallback");
assert(resolveUiLocale("system", ["fr-FR", "zh-Hans"]) === "zh-CN", "secondary zh");
assert(resolveUiLocale("system", []) === "en", "empty fallback");
assert(resolveUiLocale("zh-CN", ["en-US"]) === "zh-CN", "manual zh override");
assert(resolveUiLocale("en", ["zh-CN"]) === "en", "manual en override");

assert(translate("zh-CN", "common.settings") === "设置", "Chinese settings");
assert(translate("en", "common.settings") === "Settings", "English settings");
assert(
  translate("zh-CN", "export.downloadFile", { name: "demo.mp4" }) ===
    "下载 demo.mp4",
  "named interpolation"
);

const zh = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate("zh-CN", key, params);
assert(
  localizeRuntimeMessage("Transcribing…", zh) === "正在转录…",
  "runtime progress localization"
);
assert(
  localizeRuntimeMessage("Detecting language…", zh) === "正在识别源语言…",
  "language detection progress localization"
);
assert(
  localizeRuntimeMessage("No words to export.", zh) === "没有可导出的文字。",
  "runtime error localization"
);
assert(localizeRuntimeMessage("Unknown diagnostic", zh) === "Unknown diagnostic", "fallback");

const now = Date.UTC(2026, 7, 9, 12, 0, 0);
assert(formatRelativeTime("zh-CN", now - 5 * 60_000, now).includes("5"), "zh relative");
assert(formatRelativeTime("en", now - 5 * 60_000, now).includes("5"), "en relative");

console.log("ALL I18N TESTS PASSED");
