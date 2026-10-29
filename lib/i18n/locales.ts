/**
 * Supported UI locales and BCP-47 matching rules.
 *
 * Adding a locale: append an entry here, add `messages/<id>.ts` +
 * `electron/locale/<id>.ts`, and register the catalog in the message maps.
 * Detection, Settings, the boot script, and Electron IPC all read from this list.
 */
export const UI_LOCALES = [
  "en",
  "zh-CN",
  "zh-TW",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "pt",
  "it",
] as const;

export type UiLocale = (typeof UI_LOCALES)[number];
export type UiLocalePreference = "system" | UiLocale;

export const DEFAULT_UI_LOCALE: UiLocale = "en";
export const DEFAULT_UI_LOCALE_PREFERENCE: UiLocalePreference = "system";
export const UI_LOCALE_STORAGE_KEY = "rescript.ui-locale";

export type UiLocaleMeta = {
  /** BCP-47 tag used for `document.documentElement.lang` and Intl. */
  htmlLang: string;
  /** Native endonym shown in the language picker (not translated). */
  nativeLabel: string;
  /** electron-builder NSIS language code, when an installer translation exists. */
  nsis?: string;
  /** Return true when a lowered BCP-47 tag should resolve to this locale. */
  match: (tag: string) => boolean;
};

const prefix =
  (base: string) =>
  (tag: string): boolean =>
    tag === base || tag.startsWith(`${base}-`);

export const UI_LOCALE_META: Record<UiLocale, UiLocaleMeta> = {
  en: {
    htmlLang: "en",
    nativeLabel: "English",
    nsis: "en_US",
    match: prefix("en"),
  },
  "zh-CN": {
    htmlLang: "zh-CN",
    nativeLabel: "简体中文",
    nsis: "zh_CN",
    // Bare `zh` and Hans variants → Simplified. Traditional tags are handled by zh-TW.
    match: (tag) => {
      if (isTraditionalChinese(tag)) return false;
      return tag === "zh" || tag.startsWith("zh-");
    },
  },
  "zh-TW": {
    htmlLang: "zh-TW",
    nativeLabel: "繁體中文",
    nsis: "zh_TW",
    match: isTraditionalChinese,
  },
  ja: {
    htmlLang: "ja",
    nativeLabel: "日本語",
    nsis: "ja_JP",
    match: prefix("ja"),
  },
  ko: {
    htmlLang: "ko",
    nativeLabel: "한국어",
    nsis: "ko_KR",
    match: prefix("ko"),
  },
  es: {
    htmlLang: "es",
    nativeLabel: "Español",
    nsis: "es_ES",
    match: prefix("es"),
  },
  fr: {
    htmlLang: "fr",
    nativeLabel: "Français",
    nsis: "fr_FR",
    match: prefix("fr"),
  },
  de: {
    htmlLang: "de",
    nativeLabel: "Deutsch",
    nsis: "de_DE",
    match: prefix("de"),
  },
  pt: {
    htmlLang: "pt",
    nativeLabel: "Português",
    nsis: "pt_BR",
    match: prefix("pt"),
  },
  it: {
    htmlLang: "it",
    nativeLabel: "Italiano",
    nsis: "it_IT",
    match: prefix("it"),
  },
};

function isTraditionalChinese(tag: string): boolean {
  if (tag === "zh-hant" || tag.startsWith("zh-hant-")) return true;
  if (tag === "zh-tw" || tag.startsWith("zh-tw-")) return true;
  if (tag === "zh-hk" || tag.startsWith("zh-hk-")) return true;
  if (tag === "zh-mo" || tag.startsWith("zh-mo-")) return true;
  return false;
}

/** Match order: check Traditional Chinese before the broad Simplified `zh*` rule. */
const MATCH_ORDER: readonly UiLocale[] = [
  "zh-TW",
  "zh-CN",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "en",
];

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && (UI_LOCALES as readonly string[]).includes(value);
}

export function isUiLocalePreference(value: unknown): value is UiLocalePreference {
  return value === "system" || isUiLocale(value);
}

/**
 * Map a BCP-47 tag onto a supported UI locale, or `null` if unsupported.
 * Traditional Chinese tags win over the generic `zh*` → Simplified rule.
 */
export function matchUiLocale(tag: string): UiLocale | null {
  const normalized = tag.trim().toLowerCase().replaceAll("_", "-");
  if (!normalized) return null;
  for (const locale of MATCH_ORDER) {
    if (UI_LOCALE_META[locale].match(normalized)) return locale;
  }
  return null;
}

/**
 * Resolve the effective UI locale.
 * For `system`, the first supported language in the browser/OS list wins.
 */
export function resolveUiLocale(
  preference: UiLocalePreference,
  systemLanguages: readonly string[]
): UiLocale {
  if (preference !== "system") return preference;
  for (const raw of systemLanguages) {
    const matched = matchUiLocale(raw);
    if (matched) return matched;
  }
  return DEFAULT_UI_LOCALE;
}

/** Inline boot script so `document.documentElement.lang` is correct before paint. */
export function buildLocaleBootScript(): string {
  const rules = MATCH_ORDER.map((locale) => {
    const meta = UI_LOCALE_META[locale];
    // Encode each matcher as an explicit check list for the boot IIFE.
    if (locale === "zh-TW") {
      return `if(v==="zh-hant"||v.indexOf("zh-hant-")===0||v==="zh-tw"||v.indexOf("zh-tw-")===0||v==="zh-hk"||v.indexOf("zh-hk-")===0||v==="zh-mo"||v.indexOf("zh-mo-")===0){l=${JSON.stringify(locale)};break}`;
    }
    if (locale === "zh-CN") {
      return `if(v==="zh"||v.indexOf("zh-")===0){l=${JSON.stringify(locale)};break}`;
    }
    const base = meta.htmlLang.split("-")[0];
    return `if(v===${JSON.stringify(base)}||v.indexOf(${JSON.stringify(`${base}-`)})===0){l=${JSON.stringify(locale)};break}`;
  }).join("");

  return `(function(){try{var p=localStorage.getItem(${JSON.stringify(UI_LOCALE_STORAGE_KEY)})||"system";var l=p;if(p==="system"){var a=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];l=${JSON.stringify(DEFAULT_UI_LOCALE)};for(var i=0;i<a.length;i++){var v=(a[i]||"").toLowerCase().replace(/_/g,"-");${rules}}}else{var allowed=${JSON.stringify([...UI_LOCALES])};if(allowed.indexOf(l)<0)l=${JSON.stringify(DEFAULT_UI_LOCALE)}}document.documentElement.lang=l}catch(e){}})();`;
}

export function nsisInstallerLanguages(): string[] {
  const codes: string[] = [];
  for (const locale of UI_LOCALES) {
    const code = UI_LOCALE_META[locale].nsis;
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}
