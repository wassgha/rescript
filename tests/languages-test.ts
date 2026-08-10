import {
  DEFAULT_TRANSCRIPT_LANGUAGE,
  isTranscriptLanguage,
  isTranscriptLanguagePreference,
  TRANSCRIPT_LANGUAGE_PREFERENCE_ORDER,
  TRANSCRIPT_LANGUAGE_ORDER,
  TRANSCRIPT_LANGUAGES,
} from "../lib/languages";

{
  if (DEFAULT_TRANSCRIPT_LANGUAGE !== "auto") {
    throw new Error("expected default language preference to be auto");
  }
  if (isTranscriptLanguage("auto")) throw new Error("did not expect auto to be valid");
  if (!isTranscriptLanguagePreference("auto")) {
    throw new Error("expected auto to be a valid preference");
  }
  if (!isTranscriptLanguage("en")) throw new Error("expected en to be valid");
  if (!isTranscriptLanguage("es")) throw new Error("expected es to be valid");
  if (!isTranscriptLanguage("fr")) throw new Error("expected fr to be valid");
  if (!isTranscriptLanguage("de")) throw new Error("expected de to be valid");
  if (!isTranscriptLanguage("zh")) throw new Error("expected zh to be valid");
  if (isTranscriptLanguage("pt")) throw new Error("did not expect pt to be valid");
}

{
  if (TRANSCRIPT_LANGUAGE_PREFERENCE_ORDER.join(",") !== "auto,en,es,fr,de,zh") {
    throw new Error(
      `unexpected preference order: ${TRANSCRIPT_LANGUAGE_PREFERENCE_ORDER.join(",")}`
    );
  }
}

{
  const labels = TRANSCRIPT_LANGUAGE_ORDER.map(
    (id) => TRANSCRIPT_LANGUAGES[id].nativeLabel
  );
  if (labels.join(",") !== "English,Español,Français,Deutsch,中文") {
    throw new Error(`unexpected language order: ${labels.join(",")}`);
  }
}

{
  for (const id of TRANSCRIPT_LANGUAGE_ORDER) {
    const info = TRANSCRIPT_LANGUAGES[id];
    if (!info.flag) throw new Error(`expected flag for ${id}`);
    if (!info.code) throw new Error(`expected code for ${id}`);
    if (info.code !== id.toUpperCase()) {
      throw new Error(`unexpected code for ${id}: ${info.code}`);
    }
  }
}

console.log("ALL LANGUAGE TESTS PASSED");
