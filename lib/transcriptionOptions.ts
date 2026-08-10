import type {
  TranscriptLanguage,
  TranscriptLanguagePreference,
} from "./languages";

export interface WhisperLanguageOptions {
  task: "transcribe";
  language?: string;
}

/** Resolve a saved UI preference to the concrete hint accepted by ASR backends. */
export function resolveTranscriptLanguage(
  preference: TranscriptLanguagePreference
): TranscriptLanguage | undefined {
  return preference === "auto" ? undefined : preference;
}

/**
 * Whisper must always transcribe in the source language. In automatic mode the
 * language key is omitted so Whisper can detect it from the audio.
 */
export function whisperLanguageOptions(
  language: string | undefined
): WhisperLanguageOptions {
  return language
    ? { task: "transcribe", language }
    : { task: "transcribe" };
}
