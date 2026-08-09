"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  loadUiLocalePreference,
  resolveUiLocale,
  saveUiLocalePreference,
  systemLanguages,
  translate,
  UI_LOCALE_STORAGE_KEY,
  type MessageKey,
  type Translate,
  type UiLocale,
  type UiLocalePreference,
} from "@/lib/i18n";

interface I18nContextValue {
  locale: UiLocale;
  preference: UiLocalePreference;
  setPreference: (preference: UiLocalePreference) => void;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export default function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<UiLocalePreference>(
    loadUiLocalePreference
  );
  const [languages, setLanguages] = useState<string[]>(systemLanguages);
  const locale = resolveUiLocale(preference, languages);

  const setPreference = useCallback((next: UiLocalePreference) => {
    saveUiLocalePreference(next);
    setPreferenceState(next);
  }, []);

  useEffect(() => {
    const refreshSystemLanguages = () => setLanguages(systemLanguages());
    const syncStorage = (event: StorageEvent) => {
      if (event.key !== UI_LOCALE_STORAGE_KEY) return;
      setPreferenceState(loadUiLocalePreference());
    };
    window.addEventListener("languagechange", refreshSystemLanguages);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener("languagechange", refreshSystemLanguages);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translate(locale, "app.title");
    window.rescriptDesktop?.setUiLocale(locale);
  }, [locale]);

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale]
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, preference, setPreference, t }),
    [locale, preference, setPreference, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
