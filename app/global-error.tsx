"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/sentry";
import {
  loadUiLocalePreference,
  resolveUiLocale,
  systemLanguages,
  translate,
} from "@/lib/i18n";

/**
 * Last-resort boundary for a crash that escaped the editor's own error handling.
 *
 * `global-error` replaces the root layout when it renders, so it gets neither
 * globals.css nor the `dark` class the appearance toggle sets — hence inline
 * styles and a `prefers-color-scheme` block rather than Tailwind. Metadata
 * exports aren't supported here either, so the title is a React element.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const locale = resolveUiLocale(
    loadUiLocalePreference(),
    systemLanguages()
  );
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  useEffect(() => {
    reportError(error, "render");
  }, [error]);

  return (
    <html lang={locale}>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          font: "15px/1.6 system-ui, -apple-system, sans-serif",
          background: "var(--bg)",
          color: "var(--fg)",
        }}
      >
        <title>{t("globalError.title")}</title>
        <style>{`
          :root { --bg: #fafafa; --fg: #18181b; --muted: #71717a; --btn: #18181b; --btnfg: #fff; }
          @media (prefers-color-scheme: dark) {
            :root { --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa; --btn: #fafafa; --btnfg: #18181b; }
          }
        `}</style>
        <main style={{ padding: "2rem", textAlign: "center", maxWidth: "34rem" }}>
          <h1 style={{ fontSize: "17px", fontWeight: 600, margin: 0 }}>
            {t("globalError.heading")}
          </h1>
          <p style={{ color: "var(--muted)", fontSize: "13px", marginTop: "0.75rem" }}>
            {t("globalError.body")}
          </p>
          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{
              marginTop: "1.5rem",
              cursor: "pointer",
              border: 0,
              borderRadius: "999px",
              padding: "0.5rem 1.25rem",
              fontSize: "13px",
              fontWeight: 500,
              background: "var(--btn)",
              color: "var(--btnfg)",
            }}
          >
            {t("common.retry")}
          </button>
        </main>
      </body>
    </html>
  );
}
