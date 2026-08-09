import {
  resolveTranscriptLanguage,
  whisperLanguageOptions,
} from "../lib/transcriptionOptions";
import type { TranscriptLanguage } from "../lib/languages";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

assert(resolveTranscriptLanguage("auto") === undefined, "auto must omit language");
assert(resolveTranscriptLanguage("zh") === "zh", "zh must remain concrete");

const automatic = whisperLanguageOptions(undefined);
assert(automatic.task === "transcribe", "auto must transcribe");
assert(!("language" in automatic), "auto must not contain a language key");

for (const language of ["en", "es", "fr", "de", "zh"] satisfies TranscriptLanguage[]) {
  const options = whisperLanguageOptions(language);
  assert(options.task === "transcribe", `${language} must transcribe`);
  assert(options.language === language, `${language} must be passed through`);
  assert(options.task !== ("translate" as "transcribe"), "translate must never be used");
}

const detected = whisperLanguageOptions("ja");
assert(detected.task === "transcribe", "a detected language must still transcribe");
assert(detected.language === "ja", "a detected Whisper language code must pass through");

console.log("ALL TRANSCRIPTION OPTIONS TESTS PASSED");
