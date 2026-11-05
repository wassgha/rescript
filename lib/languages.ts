export type TranscriptLanguage = "en" | "es" | "fr" | "de" | "pt" | "zh" | "sv";

export interface TranscriptLanguageInfo {
  label: string;
  nativeLabel: string;
  /** Flag emoji shown beside the language name in the submenu. */
  flag: string;
  /** Short uppercase code shown in the model selector trigger. */
  code: string;
}

const LANGUAGE_STORAGE_KEY = "rescript.transcript-language";

export const DEFAULT_TRANSCRIPT_LANGUAGE: TranscriptLanguage = "en";

export const TRANSCRIPT_LANGUAGES: Record<
  TranscriptLanguage,
  TranscriptLanguageInfo
> = {
  en: {
    label: "English",
    nativeLabel: "English",
    flag: "🇺🇸",
    code: "EN",
  },
  es: {
    label: "Spanish",
    nativeLabel: "Español",
    flag: "🇪🇸",
    code: "ES",
  },
  fr: {
    label: "French",
    nativeLabel: "Français",
    flag: "🇫🇷",
    code: "FR",
  },
  de: {
    label: "German",
    nativeLabel: "Deutsch",
    flag: "🇩🇪",
    code: "DE",
  },
  pt: {
    label: "Portuguese",
    nativeLabel: "Português",
    flag: "🇧🇷",
    code: "PT",
  },
  sv: {
    label: "Swedish",
    nativeLabel: "Svenska",
    flag: "🇸🇪",
    code: "SV",
  },
  zh: {
    label: "Chinese",
    nativeLabel: "中文",
    flag: "🇨🇳",
    code: "ZH",
  },
};

export const TRANSCRIPT_LANGUAGE_ORDER: TranscriptLanguage[] = [
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "zh",
  "sv",
];

export function isTranscriptLanguage(
  value: unknown
): value is TranscriptLanguage {
  return (
    value === "en" ||
    value === "es" ||
    value === "fr" ||
    value === "de" ||
    value === "pt" ||
    value === "sv" ||
    value === "zh"
  );
}

/** Read the last-selected transcript language from localStorage. */
export function loadTranscriptLanguagePreference(): TranscriptLanguage {
  if (typeof window === "undefined") return DEFAULT_TRANSCRIPT_LANGUAGE;
  try {
    const raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isTranscriptLanguage(raw)) return raw;
  } catch {
    // private mode / disabled storage
  }
  return DEFAULT_TRANSCRIPT_LANGUAGE;
}

/** Persist the selected transcript language for the next visit. */
export function saveTranscriptLanguagePreference(language: TranscriptLanguage) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // private mode / disabled storage
  }
}
