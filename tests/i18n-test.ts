import { readFileSync } from "node:fs";

import {
  UI_LOCALES,
  buildLocaleBootScript,
  formatRelativeTime,
  localizeRuntimeMessage,
  matchUiLocale,
  nsisInstallerLanguages,
  resolveUiLocale,
  runtimeEnglishMessages,
  runtimeMessageKeys,
  translate,
} from "../lib/i18n";
import { catalogs } from "../lib/i18n/catalogs";
import { en, type MessageKey } from "../lib/i18n/messages/en";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

assert(resolveUiLocale("system", ["zh-CN"]) === "zh-CN", "zh-CN detection");
assert(resolveUiLocale("system", ["zh-HK"]) === "zh-TW", "zh-HK → Traditional");
assert(resolveUiLocale("system", ["zh-TW"]) === "zh-TW", "zh-TW detection");
assert(resolveUiLocale("system", ["zh-Hans-CN"]) === "zh-CN", "zh-Hans");
assert(resolveUiLocale("system", ["ja-JP"]) === "ja", "japanese detection");
assert(resolveUiLocale("system", ["ko"]) === "ko", "korean detection");
assert(resolveUiLocale("system", ["es-MX"]) === "es", "spanish detection");
assert(resolveUiLocale("system", ["fr-CA"]) === "fr", "french detection");
assert(resolveUiLocale("system", ["de-AT"]) === "de", "german detection");
assert(resolveUiLocale("system", ["pt-BR"]) === "pt", "portuguese detection");
assert(resolveUiLocale("system", ["it-IT"]) === "it", "italian detection");
assert(resolveUiLocale("system", ["pt-PT", "en-US"]) === "pt", "portuguese ordered");
assert(resolveUiLocale("system", ["fr-FR", "en-US"]) === "fr", "ordered fallback");
assert(resolveUiLocale("system", ["xx-YY", "en-US"]) === "en", "unsupported then en");
assert(resolveUiLocale("system", []) === "en", "empty fallback");
assert(resolveUiLocale("ja", ["en-US"]) === "ja", "manual override");
assert(matchUiLocale("zh_TW") === "zh-TW", "underscore normalized");

assert(translate("zh-CN", "common.settings") === "设置", "Chinese settings");
assert(translate("ja", "common.settings") === "設定", "Japanese settings");
assert(translate("es", "common.settings") === "Ajustes", "Spanish settings");
assert(translate("pt", "common.settings") === "Configurações", "Portuguese settings");
assert(translate("it", "common.settings") === "Impostazioni", "Italian settings");
assert(
  translate("de", "export.downloadFile", { name: "demo.mp4" }).includes("demo.mp4"),
  "named interpolation"
);
assert(
  translate("en", "transcript.wordDeleted", { count: 1 }) === "1 word",
  "singular words deleted"
);
assert(
  translate("en", "transcript.wordsDeleted", { count: 3 }) === "3 words",
  "plural words deleted"
);

const ja = (key: MessageKey, params?: Record<string, string | number>) =>
  translate("ja", key, params);
assert(
  localizeRuntimeMessage("Transcribing…", ja).length > 0,
  "runtime progress localization"
);
assert(
  localizeRuntimeMessage("No words to export.", ja).length > 0,
  "runtime error localization"
);
assert(localizeRuntimeMessage("Unknown diagnostic", ja) === "Unknown diagnostic", "fallback");

for (const english of runtimeEnglishMessages) {
  assert(runtimeMessageKeys[english], `runtime map covers ${english}`);
  const key = runtimeMessageKeys[english];
  assert(en[key] === english, `catalog matches runtime english for ${key}`);
}

const enKeys = Object.keys(en) as MessageKey[];
for (const locale of UI_LOCALES) {
  for (const key of enKeys) {
    assert(
      typeof catalogs[locale][key] === "string" && catalogs[locale][key].length > 0,
      `${locale} has ${key}`
    );
  }
}

const nsis = nsisInstallerLanguages();
assert(nsis.includes("en_US") && nsis.includes("ja_JP") && nsis.includes("zh_TW"), "nsis codes");
assert(nsis.includes("pt_BR"), "nsis includes Portuguese");
assert(nsis.includes("it_IT"), "nsis includes Italian");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packagedNsisLanguages = packageJson.build?.nsis?.installerLanguages;
assert(Array.isArray(packagedNsisLanguages), "package has NSIS installer languages");
for (const language of nsis) {
  assert(packagedNsisLanguages.includes(language), `package includes NSIS language ${language}`);
}

const boot = buildLocaleBootScript();
assert(boot.includes("zh-TW"), "boot script knows Traditional Chinese");
assert(boot.includes("ja"), "boot script knows Japanese");
assert(boot.includes("pt"), "boot script knows Portuguese");
assert(boot.includes("navigator.languages"), "boot script reads system languages");
const now = Date.UTC(2026, 7, 9, 12, 0, 0);
assert(formatRelativeTime("ja", now - 5 * 60_000, now).includes("5"), "ja relative");
assert(formatRelativeTime("en", now - 5 * 60_000, now).includes("5"), "en relative");

console.log("ALL I18N TESTS PASSED");
