import {
  DEFAULT_TRANSCRIPT_LANGUAGE,
  isTranscriptLanguage,
  TRANSCRIPT_LANGUAGE_ORDER,
  TRANSCRIPT_LANGUAGES,
} from "../lib/languages";

{
  if (DEFAULT_TRANSCRIPT_LANGUAGE !== "en") {
    throw new Error("expected default language to be en");
  }
  if (isTranscriptLanguage("auto")) throw new Error("did not expect auto to be valid");
  if (!isTranscriptLanguage("en")) throw new Error("expected en to be valid");
  if (!isTranscriptLanguage("es")) throw new Error("expected es to be valid");
  if (!isTranscriptLanguage("fr")) throw new Error("expected fr to be valid");
  if (!isTranscriptLanguage("de")) throw new Error("expected de to be valid");
  if (!isTranscriptLanguage("pt")) throw new Error("expected pt to be valid");
  if (!isTranscriptLanguage("sv")) throw new Error("expected sv to be valid");
  if (!isTranscriptLanguage("zh")) throw new Error("expected zh to be valid");
  if (isTranscriptLanguage("it")) throw new Error("did not expect it to be valid");
}
{
  const labels = TRANSCRIPT_LANGUAGE_ORDER.map(
    (id) => TRANSCRIPT_LANGUAGES[id].nativeLabel
  );
  if (labels.join(",") !== "English,Español,Français,Deutsch,Português,中文,Svenska") {
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
