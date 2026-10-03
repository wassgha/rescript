import { en, type MessageKey } from "./messages/en";

/**
 * English strings emitted by workers / store / parsers that the UI localizes
 * after the fact. Keys are taken from the English catalog so the map cannot
 * drift from {@link en}.
 */
const runtimeMessageKeyList = [
  "progress.loadingMedia",
  "progress.loadingMediaEngine",
  "progress.extractingAudio",
  "progress.preparingMedia",
  "progress.loadingSpeechModel",
  "progress.loadingSpeechCache",
  "progress.downloadingSpeech",
  "progress.gpuFallback",
  "progress.detectingSpeech",
  "progress.transcribing",
  "progress.loadingAlignCache",
  "progress.downloadingAlign",
  "progress.aligning",
  "progress.speakers",
  "error.selectModel",
  "error.workerCrashed",
  "error.mediaEngineNetwork",
  "error.mediaEngineStalled",
  "error.mediaEngineNotReady",
  "error.simdUnsupported",
  "error.processFile",
  "error.extractAudio",
  "error.nothingToExport",
  "error.videoExport",
  "error.audioExport",
  "error.exportSave",
  "error.diskFull",
  "error.export",
  "error.timelineExport",
  "error.timelineEmpty",
  "error.aafTemplate",
  "error.emptyTranscript",
  "error.noTimedWords",
  "error.parseJson",
  "error.jsonShape",
  "error.noWords",
  "error.projectMissing",
  "error.openProject",
  "error.removeProject",
  "error.readTranscript",
  "error.clearRecent",
  "error.modelDownload",
  "error.gpuReset",
] as const satisfies readonly MessageKey[];

export type RuntimeMessageKey = (typeof runtimeMessageKeyList)[number];

export const runtimeMessageKeys: Record<string, MessageKey> = Object.fromEntries(
  runtimeMessageKeyList.map((key) => [en[key], key])
);

/** English strings currently expected from runtime emitters (for tests). */
export const runtimeEnglishMessages: readonly string[] = runtimeMessageKeyList.map(
  (key) => en[key]
);
