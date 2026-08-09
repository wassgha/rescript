/**
 * Transcription worker: runs entirely in the browser.
 *
 * 1. Silero VAD (energy fallback) finds speech segments; silence is skipped.
 * 2. ASR (Whisper via transformers.js, or Parakeet TDT v3 via parakeet.js)
 *    transcribes each segment with per-word timestamps, remapped onto the
 *    original timeline.
 * 3. CTC forced alignment (language-specific wav2vec2 / MMS) measures word
 *    boundaries against the audio; a VAD/envelope heuristic is the fallback.
 * 4. Pyannote segmentation 3.0 assigns a speaker to each word.
 *
 * ASR backends live in one weightlift ModelManager (download progress, cache
 * labeling, WebGPU→WASM fallback). The CTC aligner has its own registry so a
 * GPU loss does not unload WASM aligner weights. Weights land in Cache Storage
 * (Whisper, aligner) or IndexedDB (Parakeet); later runs are offline. ORT WASM
 * is served same-origin from /vendor/ort* .
 */
import {
  pipeline,
  AutoProcessor,
  AutoModel,
  AutoModelForAudioFrameClassification,
  AutoModelForCTC,
  AutoTokenizer,
  WhisperTextStreamer,
  Tensor,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import { ModelManager, type ModelDefinition } from "weightlift";
import {
  fallbackDevicePolicy,
  isTransformersModelCached,
  transformersModel,
  transformersProgress,
} from "weightlift/transformers";
import type { Word, WorkerRequest, WorkerResponse } from "@/lib/types";
import {
  MODELS,
  isParakeetModel,
  isWhisperModel,
  isCrisperModel,
  type ModelId,
  type WhisperModel,
} from "@/lib/models";
import { cleanTranscript } from "@/lib/hallucinations";
import {
  ALIGN_LEAD_S,
  alignWordsToSpeech,
  applyAlignLead,
  speechEnvelope,
} from "@/lib/align";
import {
  ALIGN_MODELS,
  alignModelFor,
  type AlignModelInfo,
} from "@/lib/alignModels";
import { insertDisfluencyPlaceholders } from "@/lib/disfluencies";
import {
  diarizationWindows,
  stitchDiarizationWindows,
  type DiarizationSegment,
  type DiarizationWindow,
} from "@/lib/diarize";
import {
  alignBatch,
  expandToAcoustics,
  groupWordsForAlignment,
  ctcVocabFromTokenizer,
  type CtcEmission,
  type CtcTokenizerLike,
  type CtcVocab,
} from "@/lib/forcedAlign";
import type { TranscriptLanguage } from "@/lib/languages";
import {
  VAD_FRAME_SIZE,
  VAD_SAMPLE_RATE,
  energySpeechFrames,
  speechSegmentsFromFrames,
  type SpeechSegment,
} from "@/lib/vad";
import { isNetworkError, installFetchRetry } from "@/lib/network";
import { isWebGpuDeviceLostError } from "@/lib/webgpu";

/**
 * Weight downloads are the longest-running fetches in the app (over a gigabyte
 * for Parakeet on WebGPU), so a momentary drop anywhere in one used to fail the
 * whole transcription with a bare "Failed to fetch". Retry them.
 *
 * parakeet.js and onnxruntime call the global, which the install replaces.
 * transformers.js does not: it binds `globalThis.fetch` into `env.fetch` when its
 * module is first evaluated — which, imports being hoisted, is already done by
 * the time this line runs — so it has to be pointed at the wrapper by hand.
 */
env.fetch = installFetchRetry(self as unknown as { fetch: typeof fetch });

env.allowLocalModels = false;
/**
 * Where {@link MODELS} entries flagged `local` are served from — an export that
 * has not been published to the Hub yet, sitting in public/models/<id>/.
 * Enabled only for the duration of such a load (see `servedLocally`), because
 * `allowLocalModels` is global: left on, every Hub model would probe this path
 * and 404 for each of its files before falling back.
 */
const LOCAL_MODEL_PATH = "/models/";
const ORT_WASM_PATHS = "/vendor/ort/";
/** Parakeet.js pins onnxruntime-web@1.24.1 — keep its WASM on a separate path. */
const PARAKEET_ORT_WASM_PATHS = "/vendor/ort-parakeet/";
// Serve onnxruntime-web WASM from our own origin (offline friendly).
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = ORT_WASM_PATHS;
}

/**
 * WebKit — Safari everywhere, plus every browser on iOS — kills the tab for
 * memory far sooner than Chromium ("This webpage was reloaded because it was
 * using significant memory"), and onnxruntime's WebGPU path is what pushes it
 * over. That path loads the JSEP build (26 MB of wasm against 13 MB for the
 * plain threaded one, all compiled up front by JSC) and then uploads every
 * weight into Metal buffers during session creation, which is precisely where
 * the reload lands. Staying on WASM costs throughput but is the difference
 * between finishing a transcript and losing the tab mid-run.
 *
 * Sniffed rather than feature-detected on purpose: there is nothing to detect.
 * WebGPU is present and functional here — it is the memory ceiling around it
 * that differs, and no API reports that. `vendor` is frozen to Apple's string
 * across WebKit, which is the exact set of engines affected.
 */
if (/apple/i.test(navigator.vendor)) {
  fallbackDevicePolicy.preferWasm();
}

const DIARIZATION_MODEL = "onnx-community/pyannote-segmentation-3.0";
const VAD_MODEL = "onnx-community/silero-vad";
/** Limit diarized speaker IDs to the requested UI-friendly headroom. */
const MAX_ALLOWED_SPEAKERS = 2;
/** Raise the diarization onset confidence bar above the default soft-slice margin. */
const ONSET_THRESHOLD = 0.7;
/** Viterbi needs a frames x tokens lattice, so alignment runs in bounded batches. */
const ALIGN_BATCH_MAX_S = 20;
/** Context either side of a batch, so edge words are not clipped. */
const ALIGN_BATCH_PAD_S = 0.2;
/** Gaps longer than this split speech into separate Whisper jobs. */
const SPEECH_MAX_GAP_S = 1.5;
/** Pad each speech region so phoneme edges are not clipped. */
const SPEECH_PAD_S = 0.4;
/**
 * Whisper often emits EOS after the first speaker when a VAD slice starts on
 * speech with no leading silence. Prepend this much zero-pad before decode
 * (timestamps are remapped so the pad does not shift the timeline).
 */
const WHISPER_LEAD_PAD_S = 0.5;

type AsrChunk = { text: string; timestamp: [number, number | null] };

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

/**
 * Live progress / partial-text updates are coalesced onto a timer.
 *
 * Both fire once per decoded token — tens of thousands of times on a long
 * recording — and each one costs a structured clone across the worker
 * boundary plus a store write and a React render on the main thread. For the
 * partial text that clone is of the whole transcript so far, so the cost grows
 * with the transcript and the total work is quadratic: an hour of speech moved
 * hundreds of megabytes of short-lived strings for a preview nobody can read
 * at that rate. 10 updates a second looks identical and is O(n).
 */
const LIVE_POST_INTERVAL_MS = 50;
/**
 * The preview is a "something is happening" affordance pinned above the
 * progress bar, not a readable document — only the last few lines are ever on
 * screen. Sending the tail keeps each message a fixed size no matter how long
 * the recording is.
 */
const PARTIAL_TAIL_CHARS = 550;

let pendingProgress: WorkerResponse | null = null;
let pendingPartial: WorkerResponse | null = null;
let liveTimer: ReturnType<typeof setTimeout> | null = null;

function flushLive() {
  if (liveTimer !== null) {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
  if (pendingProgress) {
    post(pendingProgress);
    pendingProgress = null;
  }
  if (pendingPartial) {
    post(pendingPartial);
    pendingPartial = null;
  }
}

/**
 * Drop queued updates without sending them. Used before a terminal message,
 * which supersedes anything still in flight.
 */
function cancelLive() {
  if (liveTimer !== null) {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
  pendingProgress = null;
  pendingPartial = null;
}

/** Queue a coalescing update; the newest value for each type wins. */
function postLive(msg: WorkerResponse) {
  if (msg.type === "partial") pendingPartial = msg;
  else pendingProgress = msg;
  if (liveTimer === null) {
    liveTimer = setTimeout(flushLive, LIVE_POST_INTERVAL_MS);
  }
}

/** Queue the streaming transcript preview, trimmed to its tail. */
function postPartial(text: string) {
  postLive({
    type: "partial",
    text:
      text.length > PARTIAL_TAIL_CHARS
        ? `…${text.slice(-PARTIAL_TAIL_CHARS)}`
        : text,
  });
}

/** Device the current ASR pipeline is running on. */
let asrDevice: "webgpu" | "wasm" = "wasm";

/** The part of an onnxruntime InferenceSession we need to free one. */
type OrtSessionLike = { release?: () => Promise<void> };

type ParakeetInstance = {
  transcribe: (
    audio: Float32Array,
    sampleRate?: number,
    opts?: {
      returnTimestamps?: boolean;
      timeOffset?: number;
    }
  ) => Promise<{
    utterance_text: string;
    words: Array<{ text: string; start_time: number; end_time: number }>;
  }>;
  /**
   * parakeet.js has no dispose() of its own — it disposes per-call tensors but
   * never the sessions — so unloading it means releasing these by hand. Optional
   * because they are internals, not part of its public surface.
   */
  encoderSession?: OrtSessionLike;
  joinerSession?: OrtSessionLike;
  _onnxPreprocessor?: { session?: OrtSessionLike | null } | null;
};

const PARAKEET_CACHE_DB = "parakeet-cache-db";
const PARAKEET_CACHE_STORE = "file-store";

/** Whether Parakeet ONNX weights already sit in parakeet.js IndexedDB. */
async function isParakeetCached(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  // Avoid opening (and thereby creating) the DB when nothing has been cached.
  try {
    if (typeof indexedDB.databases === "function") {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === PARAKEET_CACHE_DB)) return false;
    }
  } catch {
    // databases() can throw in private mode; fall through to open().
  }

  const repoId = MODELS.parakeet.repoId;
  // Hub keys: `hf-${repoId}-main--${filename}` (empty subfolder).
  const candidates = [
    `hf-${repoId}-main--encoder-model.int8.onnx`,
    `hf-${repoId}-main--encoder-model.fp16.onnx`,
  ];
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(PARAKEET_CACHE_DB);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
      req.onsuccess = () => resolve(req.result);
    });
    if (!db.objectStoreNames.contains(PARAKEET_CACHE_STORE)) {
      db.close();
      return false;
    }
    const hit = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction([PARAKEET_CACHE_STORE], "readonly");
      const store = tx.objectStore(PARAKEET_CACHE_STORE);
      let pending = candidates.length;
      let found = false;
      for (const key of candidates) {
        const req = store.get(key);
        req.onsuccess = () => {
          const blob = req.result as Blob | undefined;
          if (blob && blob.size > 1_000_000) found = true;
          pending -= 1;
          if (pending === 0) resolve(found);
        };
        req.onerror = () => reject(req.error ?? new Error("IndexedDB get failed"));
      }
    });
    db.close();
    return hit;
  } catch {
    return false;
  }
}

/**
 * Parakeet via parakeet.js — custom weightlift definition (not transformers.js).
 * WebGPU uses fp16 encoder; WASM int8 is the size / compatibility fallback.
 */
function parakeetModel(): ModelDefinition<ParakeetInstance> {
  return {
    isCached: isParakeetCached,
    dispose: async (model) => {
      await Promise.all([
        model.encoderSession?.release?.(),
        model.joinerSession?.release?.(),
        model._onnxPreprocessor?.session?.release?.(),
      ]);
    },
    load: async ({ progress }) => {
      const { fromHub } = await import("parakeet.js");
      const onProgress = (p: { loaded: number; total: number; file: string }) => {
        if (!p.file) return;
        progress.dispatch({
          type: "progress",
          file: p.file,
          loaded: p.loaded,
          ...(p.total > 0 ? { total: p.total } : {}),
        });
      };
      const common = {
        // nemo128.onnx is NeMo's own featurisation graph (0.1 MB). The "js"
        // alternative is a hand-written mel — its own FFT and slaney filterbank —
        // and any drift from NeMo's exact features degrades every prediction in
        // a way that reads as "the model is just worse".
        preprocessorBackend: "onnx" as const,
        progress: onProgress,
        wasmPaths: PARAKEET_ORT_WASM_PATHS,
      };

      /**
       * Encoder quantisation is a size decision; decoder quantisation is not.
       *
       * In a TDT model the decoder/joint network is what emits tokens, so
       * quantising it lands directly on word accuracy — and it is tiny next to
       * the encoder (fp32 72 MB, fp16 36 MB, int8 18 MB, against 1239 MB for
       * the fp16 encoder). parakeet.js defaults both to int8; taking that
       * default for the decoder traded measurable accuracy for ~1% of the
       * download, so it is set explicitly here instead.
       */
      const device = await fallbackDevicePolicy.pickDevice();
      if (device === "webgpu") {
        try {
          // fp16 encoder + fp32 decoder ≈ 1.31 GB. WebGPU cannot run the int8
          // encoder at all, so fp16 is the only practical encoder here.
          const model = await fromHub(MODELS.parakeet.id, {
            ...common,
            backend: "webgpu",
            encoderQuant: "fp16",
            decoderQuant: "fp32",
          });
          asrDevice = "webgpu";
          return model as ParakeetInstance;
        } catch (err) {
          console.warn(
            "Parakeet WebGPU/fp16 load failed; falling back to WASM int8.",
            err
          );
          fallbackDevicePolicy.preferWasm();
        }
      }

      // int8 encoder + fp16 decoder ≈ 690 MB: the compatibility / size fallback,
      // keeping the decoder off int8 for the reason above.
      const model = await fromHub(MODELS.parakeet.id, {
        ...common,
        backend: "wasm",
        encoderQuant: "int8",
        decoderQuant: "fp16",
      });
      asrDevice = "wasm";
      return model as ParakeetInstance;
    },
  };
}

/**
 * Flip `env.allowLocalModels` on for one model's load and back afterwards.
 *
 * transformers.js resolves local-vs-Hub from global state, so a model served
 * from public/models can only be reached by enabling it — but leaving it
 * enabled makes every Hub model try the local path first and 404 once per
 * file. Scoping it to the load keeps both paths clean.
 */
function servedLocally<T>(definition: ModelDefinition<T>): ModelDefinition<T> {
  const withLocalPath = async <R,>(fn: () => Promise<R>): Promise<R> => {
    const previousAllow = env.allowLocalModels;
    const previousPath = env.localModelPath;
    env.allowLocalModels = true;
    env.localModelPath = LOCAL_MODEL_PATH;
    try {
      return await fn();
    } finally {
      env.allowLocalModels = previousAllow;
      env.localModelPath = previousPath;
    }
  };

  return {
    ...definition,
    load: (ctx) => withLocalPath(() => definition.load(ctx)),
    ...(definition.isCached
      ? { isCached: () => withLocalPath(async () => definition.isCached!()) }
      : {}),
  };
}

/**
 * ASR registry keyed by each model's `id` from MODELS. Definitions are
 * registered up front; loaders only take an id. unloadAll() after a WebGPU
 * loss forces a clean reload on WASM.
 */
const models = new ModelManager({
  models: Object.fromEntries(
    (Object.keys(MODELS) as ModelId[]).map((choice) => {
      const info = MODELS[choice];
      if (info.backend === "parakeet") {
        return [info.id, parakeetModel()];
      }
      const definition = transformersModel<AutomaticSpeechRecognitionPipeline>({
        pipeline,
        task: "automatic-speech-recognition",
        modelId: info.id,
        dtype: info.dtype,
        cacheKey: env.cacheKey ?? "transformers-cache",
        onDevice: (device) => {
          asrDevice = device;
        },
        // Without this, unload() drops the JS reference and nothing else: the
        // ORT sessions — the weights, and on WebGPU the GPU buffers holding
        // them — stay alive with no way left to reach them. See releaseAsr().
        dispose: (transcriber) => transcriber.dispose(),
      });
      return [info.id, info.local ? servedLocally(definition) : definition];
    })
  ),
});
models.subscribe((snap) => {
  const id = snap.loading[0];
  if (!id) return;
  const rec = snap.models[id];
  if (!rec) return;
  post({
    type: "progress",
    message:
      rec.fromCache === true
        ? "Loading speech model from cache…"
        : "Downloading speech model…",
    value: rec.indeterminate ? null : rec.percent,
  });
});

/**
 * CrisperWhisper's prompt scaffolding: mode tags plus the verbatimize / hotword
 * / continuation markers. All sit at the very top of the vocabulary, above the
 * timestamp block.
 */
const CRISPER_PROMPT_TOKENS = [
  ...[1, 2, 3, 4, 5].map((i) => `[verbatim_${i}]`),
  ...[1, 2, 3, 4, 5].map((i) => `[intended_${i}]`),
  "<vtx>",
  "<evtx>",
  "<ctx>",
  "<ectx>",
  "<htx>",
  "<ehtx>",
];

/**
 * Register CrisperWhisper's prompt scaffolding as special so it can never
 * surface as literal text in a transcript.
 *
 * These are the `[verbatim_N]` / `[intended_N]` mode tags and the
 * verbatimize / hotword / context markers — decoder-prompt machinery, not
 * speech. `_decode_asr` skips anything in `all_special_ids`, which is the only
 * hook for keeping them out of the output.
 *
 * This used to carry a second job: raising `all_special_ids.at(-1)` above the
 * whole vocabulary so `decodeWithTimestamps` would stop mistaking `[UM]` and
 * `[UH]` for timestamps. That was a workaround for an upstream bug, now fixed
 * properly in patches/@huggingface+transformers+4.2.0.patch — see
 * patches/README.md. Only the narrow purpose above remains.
 *
 * Idempotent, so re-running it after a WebGPU-to-WASM reload is harmless.
 */
function markCrisperPromptTokensSpecial(
  transcriber: AutomaticSpeechRecognitionPipeline
): void {
  try {
    // Tokenizer internals are untyped in transformers.js.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenizer = transcriber.tokenizer as any;
    const ids = new Set<number>(tokenizer.all_special_ids ?? []);
    const before = ids.size;
    for (const token of CRISPER_PROMPT_TOKENS) {
      const encoded = tokenizer.encode(token, { add_special_tokens: false });
      // Anything that does not map to exactly one id is not the atomic token we
      // are looking for — skip rather than guess.
      if (encoded?.length === 1) ids.add(encoded[0]);
    }
    if (ids.size === before) return;
    // Sorted because the workaround depends on `.at(-1)` being the maximum.
    tokenizer.all_special_ids = [...ids].sort((a, b) => a - b);
  } catch {
    console.warn(
      "Could not mark CrisperWhisper prompt tokens as special; " +
        "word timestamps may fail on the first filler token."
    );
  }
}

type Aligner = {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForCTC.from_pretrained>>;
  vocab: CtcVocab;
};

/**
 * The aligner gets its own registry rather than joining `models`.
 *
 * It is a different family — an acoustic aligner, not a transcriber, and not
 * something the user picks — but the deciding factor is lifecycle. The ASR
 * registry exists under a WebGPU→WASM fallback policy whose recovery step is
 * `unloadAll()`. The aligner never asks for a device, so transformers.js runs it
 * on WASM (`DEFAULT_DEVICE`), where a lost GPU cannot touch it. Sharing the
 * registry meant a GPU loss threw away perfectly good WASM weights.
 *
 * Multiple language-specific CTC models are registered; only the one for the
 * active transcript language is loaded.
 */
function buildAlignerRegistry(): Record<string, ModelDefinition<Aligner>> {
  const byId = new Map<string, AlignModelInfo>();
  for (const info of Object.values(ALIGN_MODELS)) {
    if (!byId.has(info.id)) byId.set(info.id, info);
  }
  return Object.fromEntries(
    [...byId.entries()].map(([id, info]) => [id, alignerModel(info)])
  );
}

const aligners = new ModelManager({ models: buildAlignerRegistry() });

async function getAsr(choice: WhisperModel) {
  const transcriber = await models.load<AutomaticSpeechRecognitionPipeline>(
    MODELS[choice].id
  );
  // Keyed on the checkpoint, not on the prefix: the repair is required by
  // CrisperWhisper's vocabulary layout, so it applies even without one.
  if (isCrisperModel(choice)) {
    markCrisperPromptTokensSpecial(transcriber);
  }
  return transcriber;
}

async function getParakeet() {
  return models.load<ParakeetInstance>(MODELS.parakeet.id);
}

/**
 * Drop dead WebGPU pipelines and reload on WASM.
 * A lost GPU device invalidates every WebGPU session, so clear the whole
 * ASR cache — not just the model that was running. The aligner is a separate
 * registry and runs on WASM, so it is deliberately untouched.
 */
async function fallbackAsrToWasm() {
  fallbackDevicePolicy.preferWasm();
  asrDevice = "wasm";
  await models.unloadAll();
  post({
    type: "progress",
    message: "GPU interrupted — continuing on CPU…",
    value: null,
  });
}

/**
 * Free the ASR model once the last segment has been decoded.
 *
 * Nothing downstream touches it, but forced alignment and diarization both run
 * their own ONNX sessions after this point — so holding the transcriber through
 * them makes the peak the sum of the two rather than the larger. That peak is
 * what WebKit kills the tab over (see the note above `preferWasm()`), and the
 * transcriber is the heaviest thing in the worker by an order of magnitude:
 * Parakeet's fp16 encoder alone is 1.31 GB, against ~240 MB for the largest
 * aligner. On WebGPU those are GPU buffers and this genuinely hands them back.
 * On WASM the heap cannot shrink, so the win is narrower — the aligner
 * allocates into the freed arena instead of growing the heap past it.
 *
 * Losing the weights costs nothing: every transcription starts a fresh worker
 * (see hooks/useTranscriber.ts), so they were never reused across runs anyway.
 * Best-effort — a failure here is wasted memory, not a failed transcript.
 */
async function releaseAsr(choice: ModelId): Promise<void> {
  try {
    await models.unload(MODELS[choice].id);
  } catch (err) {
    console.warn("Could not release the speech model after transcription.", err);
  }
}

type Diarizer = {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForAudioFrameClassification.from_pretrained>>;
};

/**
 * Silero VAD: ~2 MB ONNX model that scores speech probability per 32 ms frame.
 * Used to find speech segments so Whisper never decodes long silence.
 * Falls back to energy VAD on failure.
 */
type VadModel = {
  (inputs: {
    input: InstanceType<typeof Tensor>;
    sr: InstanceType<typeof Tensor>;
    state: InstanceType<typeof Tensor>;
  }): Promise<{
    output: { data: ArrayLike<number> };
    stateN: InstanceType<typeof Tensor>;
  }>;
};

let vadPromise: Promise<VadModel | null> | null = null;
function getVad(): Promise<VadModel | null> {
  if (!vadPromise) {
    vadPromise = AutoModel.from_pretrained(VAD_MODEL, {
      // Silero ships as a custom ONNX graph without a transformers config.
      // @ts-expect-error transformers.js accepts model_type via config override
      config: { model_type: "custom" },
      dtype: "fp32",
    })
      .then((model) => model as unknown as VadModel)
      .catch((err) => {
        console.warn("Silero VAD failed to load; using energy-based silence detection.", err);
        return null;
      });
  }
  return vadPromise;
}

async function speechFramesWithSilero(
  model: VadModel,
  audio: Float32Array
): Promise<boolean[]> {
  const frameSize = VAD_FRAME_SIZE;
  const n = Math.ceil(audio.length / frameSize) || 0;
  const out: boolean[] = new Array(n);
  const sr = new Tensor("int64", [BigInt(VAD_SAMPLE_RATE)], []);
  let state = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  // Fresh buffer each frame so ORT never sees a mutated shared view.
  const threshold = 0.35;

  for (let f = 0; f < n; f++) {
    const start = f * frameSize;
    const end = Math.min(audio.length, start + frameSize);
    const frameBuf = new Float32Array(frameSize);
    frameBuf.set(audio.subarray(start, end));
    const input = new Tensor("float32", frameBuf, [1, frameSize]);
    const { output, stateN } = await model({ input, sr, state });
    state = stateN;
    out[f] = Number(output.data[0] ?? 0) >= threshold;

    if (f > 0 && f % 512 === 0) {
      post({ type: "progress", message: "Detecting speech…", value: f / n });
    }
  }
  return out;
}

/** Turn speech-frame flags into segments, with a full-audio fallback. */
function segmentsOrFull(
  frames: boolean[],
  audio: Float32Array
): SpeechSegment[] {
  const segments = speechSegmentsFromFrames(frames, audio.length, {
    maxGapS: SPEECH_MAX_GAP_S,
    padS: SPEECH_PAD_S,
  });
  if (segments.length > 0) return segments;
  console.warn("VAD found no speech; falling back to full audio.");
  return [{ startSample: 0, endSample: audio.length }];
}

/**
 * Speech segments to transcribe, plus the raw per-frame flags they came from.
 * The flags are kept because word timestamps are realigned against them once
 * decoding finishes (see lib/align.ts); `frames` is empty when detection failed
 * and the whole file is decoded as one segment, which makes that step a no-op.
 */
async function detectSpeechSegments(
  audio: Float32Array,
  vad: VadModel | null
): Promise<{ segments: SpeechSegment[]; frames: boolean[] }> {
  try {
    const frames = vad
      ? await speechFramesWithSilero(vad, audio)
      : energySpeechFrames(audio);
    return { segments: segmentsOrFull(frames, audio), frames };
  } catch (err) {
    console.warn("Speech segmentation failed; falling back to full audio.", err);
    return { segments: [{ startSample: 0, endSample: audio.length }], frames: [] };
  }
}

/** Nominal length given to a word whose end timestamp is missing or unusable. */
const FALLBACK_WORD_S = 0.5;

/** Map Whisper word chunks from a segment onto the original media timeline. */
function wordsFromChunks(
  chunks: AsrChunk[],
  offsetS: number,
  segmentDuration: number,
  mediaDuration: number
): Word[] {
  const clampLocal = (t: number) => Math.min(Math.max(t, 0), segmentDuration);
  const usable = chunks
    .map((c) => ({ text: c.text.trim(), timestamp: c.timestamp }))
    .filter((c) => c.text.length > 0);

  return usable.map((c, i) => {
    const localStart = clampLocal(c.timestamp[0] ?? 0);
    // Word timestamps come from DTW over the encoder's cross-attention, and
    // that window is always the full 30 s zero-padded input — so the last word
    // of a short slice regularly comes back ending at ~29.98 s no matter how
    // little audio there was. An end past the slice is not a long word, it is a
    // missing timestamp: fall back to a nominal length, bounded by the next
    // word. (Clamping to the media duration instead once produced a single
    // 13.7 s "word" covering the whole tail of the timeline.)
    const next = usable[i + 1];
    const nextStart = next
      ? clampLocal(next.timestamp[0] ?? segmentDuration)
      : segmentDuration;
    const rawEnd = c.timestamp[1];
    const localEnd =
      rawEnd != null && rawEnd <= segmentDuration
        ? clampLocal(rawEnd)
        : Math.min(localStart + FALLBACK_WORD_S, Math.max(localStart, nextStart));

    let start = offsetS + localStart;
    let end = offsetS + Math.max(localEnd, localStart);
    if (mediaDuration > 0) {
      start = Math.min(start, mediaDuration);
      end = Math.min(end, mediaDuration);
    }
    start = Math.max(0, start);
    return {
      id: i,
      text: c.text,
      start,
      end: Math.max(end, start + 0.02),
      speaker: 0,
      deleted: false,
    };
  });
}

/**
 * Load the diarization model. Started in the background while Whisper is
 * still transcribing, so the (small) speaker model is downloaded, cached,
 * and ready by the time the transcript lands — closing the tab right after
 * transcription no longer leaves it uncached for the next session. No
 * progress is posted here to avoid interleaving with transcription progress.
 */
let diarizerPromise: Promise<Diarizer> | null = null;
function getDiarizer(): Promise<Diarizer> {
  if (!diarizerPromise) {
    diarizerPromise = (async () => {
      const processor = await AutoProcessor.from_pretrained(DIARIZATION_MODEL, {});
      const model = await AutoModelForAudioFrameClassification.from_pretrained(
        DIARIZATION_MODEL,
        { dtype: "fp32" }
      );
      return { processor, model };
    })();
    diarizerPromise.catch(() => {
      diarizerPromise = null;
    });
  }
  return diarizerPromise;
}

/**
 * The CTC acoustic model that places word boundaries, as a weightlift
 * definition so its bytes are tracked like the ASR models rather than
 * downloading silently behind an "Aligning words…" label.
 *
 * Not `transformersModel()`: that builds a `pipeline()`, and this needs the
 * processor, model and tokenizer separately. The progress wiring is the same.
 *
 * q4 is used throughout: English wav2vec2 is ~86 MB; MMS / Chinese XLS-R are
 * ~240 MB. fp16 fails to load on onnxruntime-web.
 */
function alignerModel(info: AlignModelInfo): ModelDefinition<Aligner> {
  return {
    isCached: () =>
      isTransformersModelCached(info.id, {
        cacheKey: env.cacheKey ?? "transformers-cache",
      }),
    // Only the model owns ONNX sessions; the processor and vocab are plain JS.
    dispose: async ({ model }) => {
      await model.dispose();
    },
    load: async ({ progress }) => {
      const progress_callback = transformersProgress(progress);
      const [processor, model, tokenizer] = await Promise.all([
        AutoProcessor.from_pretrained(info.id, { progress_callback }),
        AutoModelForCTC.from_pretrained(info.id, {
          dtype: "q4",
          progress_callback,
        }),
        AutoTokenizer.from_pretrained(info.id, { progress_callback }),
      ]);
      const vocab = ctcVocabFromTokenizer(
        // Tokenizer internals are untyped in transformers.js.
        tokenizer as unknown as CtcTokenizerLike,
        info.normalize
      );
      return { processor, model, vocab };
    },
  };
}

function getAligner(language: TranscriptLanguage): Promise<Aligner> {
  const info = alignModelFor(language);
  if (!info) {
    return Promise.reject(new Error(`No CTC aligner for language: ${language}`));
  }
  return aligners.load<Aligner>(info.id);
}

/** Per-frame log-probabilities for one slice of audio. */
async function ctcEmission(aligner: Aligner, slice: Float32Array): Promise<CtcEmission> {
  const inputs = await aligner.processor(slice);
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const { logits } = await (aligner.model as any)(inputs);
  const [, frames, vocab] = logits.dims as number[];
  const data = logits.data as Float32Array;
  // The model emits raw scores; Viterbi needs log-probabilities.
  const logProbs = new Float32Array(frames * vocab);
  for (let t = 0; t < frames; t++) {
    const row = t * vocab;
    let max = -Infinity;
    for (let v = 0; v < vocab; v++) if (data[row + v] > max) max = data[row + v];
    let sum = 0;
    for (let v = 0; v < vocab; v++) sum += Math.exp(data[row + v] - max);
    const logSumExp = max + Math.log(sum);
    for (let v = 0; v < vocab; v++) logProbs[row + v] = data[row + v] - logSumExp;
  }
  return { logProbs, frames, vocab };
}

/**
 * Replace decoded word timings with boundaries measured against the audio.
 *
 * Incoming timestamps (Whisper DTW or Parakeet TDT) are only used to decide
 * which words go in which batch. Any batch that fails to align keeps the
 * timings it came in with, so a bad slice costs accuracy on those words rather
 * than losing them.
 */
async function forceAlign(
  words: Word[],
  audio: Float32Array,
  duration: number,
  language: TranscriptLanguage
): Promise<Word[]> {
  const info = alignModelFor(language);
  if (!info) return words;

  // Subscribe only while we are actually waiting. The aligner also warms in the
  // background during transcription, and those bytes must not fight the
  // "Transcribing…" line — but a wait here is worth a bar, since a cold cache
  // otherwise looks like a hang. Scoping the subscription to the await is the
  // whole gate: no shared flag to get out of step if this is ever re-entered.
  let aligner: Aligner;
  const report = (rec: ReturnType<typeof aligners.status>) => {
    if (rec.status !== "loading") return;
    post({
      type: "progress",
      message:
        rec.fromCache === true
          ? "Loading alignment model from cache…"
          : "Downloading alignment model…",
      value: rec.indeterminate ? null : rec.percent,
    });
  };
  const unsubscribe = aligners.subscribe((snap) => report(snap.models[info.id]));
  // subscribe() only fires on the next change, so prime from current state: a
  // load that has started but not yet received its first byte would otherwise
  // leave the UI sitting on "Transcribing…".
  report(aligners.status(info.id));
  try {
    aligner = await getAligner(language);
  } finally {
    unsubscribe();
  }
  // Switch off the download label as soon as the weights are in hand.
  post({ type: "progress", message: "Aligning words…", value: 0 });
  const batches = groupWordsForAlignment(words, ALIGN_BATCH_MAX_S);
  const out: Word[] = [];
  let done = 0;

  for (const batch of batches) {
    const from = Math.max(0, batch[0].start - ALIGN_BATCH_PAD_S);
    const to = Math.min(duration, batch[batch.length - 1].end + ALIGN_BATCH_PAD_S);
    const startSample = Math.floor(from * VAD_SAMPLE_RATE);
    const endSample = Math.min(audio.length, Math.ceil(to * VAD_SAMPLE_RATE));
    const slice = audio.slice(startSample, endSample);
    let aligned: Word[] | null = null;
    if (slice.length > VAD_SAMPLE_RATE / 10) {
      try {
        const emission = await ctcEmission(aligner, slice);
        aligned = alignBatch(
          batch,
          emission,
          startSample / VAD_SAMPLE_RATE,
          slice.length / VAD_SAMPLE_RATE,
          aligner.vocab
        );
      } catch (err) {
        console.warn("Forced alignment failed for one batch; keeping decoded times.", err);
      }
    }
    out.push(...(aligned ?? batch));
    done++;
    post({ type: "progress", message: "Aligning words…", value: done / batches.length });
  }
  return out;
}

/**
 * Shared post-ASR timing pass for Whisper and Parakeet.
 *
 * 1. VAD / loudness-envelope heuristic (language-agnostic fallback and batch seed)
 * 2. CTC forced alignment when a model exists for `language`
 * 3. Envelope edge expansion of peaky CTC spans
 * 4. Disfluency placeholders (after alignment — "..." has no CTC spelling)
 */
async function refineWordTimestamps(
  words: Word[],
  speechFrames: boolean[],
  audio: Float32Array,
  duration: number,
  language: TranscriptLanguage
): Promise<Word[]> {
  let out = alignWordsToSpeech(words, speechFrames, {
    duration,
    audio,
    sampleRate: VAD_SAMPLE_RATE,
  });

  if (alignModelFor(language)) {
    try {
      const measured = await forceAlign(out, audio, duration, language);
      out = expandToAcoustics(measured, speechEnvelope(audio, VAD_SAMPLE_RATE));
    } catch (err) {
      console.warn("Forced alignment unavailable; using VAD-corrected times.", err);
    }
  }

  const withPauses = insertDisfluencyPlaceholders(out, speechFrames, { duration });
  // Last, so the placeholders move with the words around them.
  return applyAlignLead(withPauses, ALIGN_LEAD_S, { duration });
}

/**
 * Segment the whole recording, one bounded window at a time.
 *
 * Feeding the model the entire file was the app's largest allocation by a wide
 * margin — see the note at the top of lib/diarize.ts. Windowing keeps every
 * forward pass the same size whatever the duration; the price is that pyannote's
 * class indices are only meaningful within a pass, which is what the overlap and
 * `stitchDiarizationWindows` are for.
 */
async function diarize(
  audio: Float32Array,
  onsetThreshold = ONSET_THRESHOLD
): Promise<DiarizationSegment[]> {
  const { processor, model } = await getDiarizer();
  // post_process_speaker_diarization is specific to the PyAnnote processor
  // and is not part of the generic Processor typings.
  const pyannote = processor as unknown as {
    post_process_speaker_diarization: (
      logits: unknown,
      numSamples: number,
      opts?: { onsetThreshold?: number; onset_threshold?: number }
    ) => DiarizationSegment[][];
  };

  const spans = diarizationWindows(audio.length, VAD_SAMPLE_RATE);
  const windows: DiarizationWindow[] = [];
  for (let i = 0; i < spans.length; i++) {
    const { startSample, endSample } = spans[i];
    // Fresh buffer rather than a subarray: non-zero byteOffset views have
    // produced wrong results from onnxruntime-web elsewhere in this worker.
    const slice = audio.slice(startSample, endSample);
    const inputs = await processor(slice);
    const { logits } = await model(inputs);
    windows.push({
      offsetS: startSample / VAD_SAMPLE_RATE,
      durationS: slice.length / VAD_SAMPLE_RATE,
      segments:
        pyannote.post_process_speaker_diarization(logits, slice.length, {
          onsetThreshold,
          onset_threshold: onsetThreshold,
        })[0] ?? [],
    });
    postLive({
      type: "progress",
      message: "Identifying speakers…",
      value: (i + 1) / spans.length,
    });
  }
  return stitchDiarizationWindows(windows);
}

/** Assign a speaker to each word from the diarization segments. */
function assignSpeakers(
  words: Word[],
  segments: DiarizationSegment[],
  maxSpeakers = MAX_ALLOWED_SPEAKERS
) {
  // Segment id 0 is "no speaker" (silence/noise); ignore it.
  const speech = segments.filter((s) => s.id !== 0);
  if (speech.length === 0) {
    for (const w of words) w.speaker = 0;
    return;
  }
  // Both lists run in time order, so a single cursor walks them together.
  // Rescanning every segment per word is O(words x segments) — fine on a clip,
  // but an hour of speech is thousands of each and this used to be unreachable
  // only because diarizing a file that long failed outright.
  const byStart = [...speech].sort((a, b) => a.start - b.start);
  let cursor = 0;

  const normalizedMax = Math.max(1, Math.round(maxSpeakers));
  const idMap = new Map<number, number>(); // pyannote id -> sequential index
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    // Advance past segments that end before this word and can no longer be the
    // containing one. Words are in time order, so this never rewinds.
    while (cursor + 1 < byStart.length && byStart[cursor].end <= mid) cursor++;

    let seg: DiarizationSegment | undefined;
    let best = Infinity;
    // The containing segment, or failing that the nearest, is at the cursor or
    // immediately beside it — a constant-size neighbourhood, not a full scan.
    for (let i = Math.max(0, cursor - 1); i < byStart.length && i <= cursor + 1; i++) {
      const s = byStart[i];
      if (mid >= s.start && mid < s.end) {
        seg = s;
        break;
      }
      const d = mid < s.start ? s.start - mid : mid - s.end;
      if (d < best) {
        best = d;
        seg = s;
      }
    }
    const raw = seg ? seg.id : -1;
    if (raw >= 0 && !idMap.has(raw)) {
      const speakerId = (parseInt(String(raw), 10) % normalizedMax) + 1;
      idMap.set(raw, speakerId);
    }
    w.speaker = raw >= 0 ? (idMap.get(raw) as number) : 0;
  }
}

/** Map Parakeet word timestamps onto the original media timeline. */
function wordsFromParakeet(
  words: Array<{ text: string; start_time: number; end_time: number }>,
  offsetS: number,
  segmentDuration: number,
  mediaDuration: number
): Word[] {
  const clampLocal = (t: number) => Math.min(Math.max(t, 0), segmentDuration);
  const usable = words
    .map((w) => ({
      text: w.text.trim(),
      start: w.start_time,
      end: w.end_time,
    }))
    .filter((w) => w.text.length > 0);

  return usable.map((w, i) => {
    const localStart = clampLocal(w.start);
    const next = usable[i + 1];
    const nextStart = next ? clampLocal(next.start) : segmentDuration;
    const localEnd =
      Number.isFinite(w.end) && w.end <= segmentDuration + 0.05
        ? clampLocal(w.end)
        : Math.min(localStart + FALLBACK_WORD_S, Math.max(localStart, nextStart));

    let start = offsetS + localStart;
    let end = offsetS + Math.max(localEnd, localStart);
    if (mediaDuration > 0) {
      start = Math.min(start, mediaDuration);
      end = Math.min(end, mediaDuration);
    }
    start = Math.max(0, start);
    return {
      id: i,
      text: w.text,
      start,
      end: Math.max(end, start + 0.02),
      speaker: 0,
      deleted: false,
    };
  });
}

async function finishWithDiarization(
  words: Word[],
  audio: Float32Array,
  onsetThreshold = ONSET_THRESHOLD,
  maxSpeakers = MAX_ALLOWED_SPEAKERS
): Promise<Word[]> {
  try {
    post({ type: "progress", message: "Identifying speakers…", value: 0 });
    const segments = await diarize(audio, onsetThreshold);
    assignSpeakers(words, segments, maxSpeakers);
  } catch (err) {
    console.warn("Speaker diarization failed; using a single speaker.", err);
  }
  return words;
}

async function runParakeet(
  audio: Float32Array,
  duration: number,
  transcriptLanguage: TranscriptLanguage,
  maxSpeakers = MAX_ALLOWED_SPEAKERS,
  onsetThreshold = ONSET_THRESHOLD
): Promise<Word[]> {
  // Overlap diarizer (+ language-matched aligner) with Parakeet load.
  getDiarizer().catch(() => {});
  if (alignModelFor(transcriptLanguage)) {
    getAligner(transcriptLanguage).catch(() => {});
  }
  const [loaded, vad] = await Promise.all([getParakeet(), getVad()]);
  let model = loaded;

  post({ type: "progress", message: "Detecting speech…", value: 0 });
  const { segments: speechSegments, frames: speechFrames } =
    await detectSpeechSegments(audio, vad);

  post({ type: "progress", message: "Transcribing…", value: 0 });
  const speechSamples = speechSegments.reduce(
    (n, s) => n + (s.endSample - s.startSample),
    0
  );

  const rawWords: Word[] = [];
  let partial = "";
  let speechDone = 0;

  for (const seg of speechSegments) {
    const segmentSamples = seg.endSample - seg.startSample;
    // Fresh buffer: non-zero byteOffset views have caused incomplete ASR with
    // onnxruntime-web in the Whisper path; keep the same hygiene here.
    const slice = audio.slice(seg.startSample, seg.endSample);
    const sliceDuration = slice.length / VAD_SAMPLE_RATE;
    const offsetS = seg.startSample / VAD_SAMPLE_RATE;

    const runSlice = () =>
      model.transcribe(slice, VAD_SAMPLE_RATE, {
        returnTimestamps: true,
        timeOffset: 0,
      });

    let result: Awaited<ReturnType<ParakeetInstance["transcribe"]>>;
    try {
      result = await runSlice();
    } catch (err) {
      if (asrDevice !== "webgpu" || !isWebGpuDeviceLostError(err)) {
        throw err;
      }
      console.warn(
        "WebGPU lost during Parakeet transcription; reloading on WASM.",
        err
      );
      await fallbackAsrToWasm();
      model = await getParakeet();
      result = await runSlice();
    }

    rawWords.push(
      ...wordsFromParakeet(result.words ?? [], offsetS, sliceDuration, duration)
    );
    const piece = (result.utterance_text ?? "").trim();
    if (piece) {
      partial = partial ? `${partial} ${piece}` : piece;
      postPartial(partial);
    }

    speechDone += segmentSamples;
    const value =
      speechSamples > 0 ? Math.min(1, speechDone / speechSamples) : 1;
    postLive({ type: "progress", message: "Transcribing…", value });
  }

  await releaseAsr("parakeet");

  const cleaned = cleanTranscript(rawWords);
  const words = await refineWordTimestamps(
    cleaned,
    speechFrames,
    audio,
    duration,
    transcriptLanguage
  );
  return finishWithDiarization(words, audio, onsetThreshold, maxSpeakers);
}

async function runWhisper(
  audio: Float32Array,
  duration: number,
  choice: WhisperModel,
  transcriptLanguage: TranscriptLanguage,
  maxSpeakers = MAX_ALLOWED_SPEAKERS,
  onsetThreshold = ONSET_THRESHOLD
): Promise<Word[]> {
  // Overlap Whisper + Silero downloads; diarizer and language-matched aligner
  // warm in the background so both are cached by the time the transcript lands.
  getDiarizer().catch(() => {});
  if (alignModelFor(transcriptLanguage)) {
    getAligner(transcriptLanguage).catch(() => {});
  }
  const [asr, vad] = await Promise.all([getAsr(choice), getVad()]);
  let transcriber = asr;

  post({ type: "progress", message: "Detecting speech…", value: 0 });
  const { segments: speechSegments, frames: speechFrames } =
    await detectSpeechSegments(audio, vad);

  const speechSamples = speechSegments.reduce(
    (n, s) => n + (s.endSample - s.startSample),
    0
  );

  post({ type: "progress", message: "Transcribing…", value: 0 });

  let partial = "";
  // Use 29s instead of 30: transformers.js has a known word-timestamp bug
  // at exactly chunk_length_s=30 (#1357 / #1358); 29 is the common workaround.
  const chunkLength = 29;
  const stride = 5;
  const timePrecision =
    // @ts-expect-error feature_extractor config is untyped
    (transcriber.processor.feature_extractor.config.chunk_length ?? 30) /
    // @ts-expect-error model config is untyped
    (transcriber.model.config.max_source_positions ?? 1500);

  let speechDone = 0;
  let transcribed = 0;
  let chunkFloor = 0;
  let chunkTokens = 0;
  let avgChunkDelta =
    speechSamples > 0
      ? Math.min(0.15, ((chunkLength - stride) * VAD_SAMPLE_RATE) / speechSamples)
      : 0.05;

  const reportProgress = (segmentLocalT: number, segmentSamples: number) => {
    const local = Math.min(
      segmentSamples,
      Math.max(0, segmentLocalT * VAD_SAMPLE_RATE)
    );
    const next = Math.max(
      transcribed,
      Math.min(1, speechSamples > 0 ? (speechDone + local) / speechSamples : 1)
    );
    const realDelta = next - chunkFloor;
    if (realDelta > 0) avgChunkDelta = avgChunkDelta * 0.5 + realDelta * 0.5;
    chunkFloor = next;
    chunkTokens = 0;
    transcribed = next;
    postLive({ type: "progress", message: "Transcribing…", value: transcribed });
  };

  /** Nudge the bar forward between chunk boundaries as tokens stream in. */
  const interpolateProgress = () => {
    chunkTokens++;
    // n/(n+8): 0.11 at token 1, 0.5 at token 8, 0.9 at token 72 — strictly
    // increasing, so it can never get stuck as long as tokens keep coming.
    const frac = chunkTokens / (chunkTokens + 8);
    const interpolated = Math.min(0.999, chunkFloor + frac * avgChunkDelta);
    if (interpolated > transcribed) {
      transcribed = interpolated;
      postLive({ type: "progress", message: "Transcribing…", value: transcribed });
    }
  };

  const asrOptions = {
    chunk_length_s: chunkLength,
    stride_length_s: stride,
    return_timestamps: "word" as const,
    // Anti-repetition: Whisper-base on multi-minute audio often falls into
    // loops like "little bit of a little bit of a…" near chunk boundaries
    // or silence. Keep penalty mild — 1.15 truncates multi-speaker clips
    // mid-utterance (second speaker dropped on continuous speech).
    no_repeat_ngram_size: 4,
    repetition_penalty: 1.05,
    // Plain decoding — no forced decoder prefix. Priming the decoder collapses
    // short VAD segments on every model here, whether with Whisper's
    // <|startofprev|> filler prompt or CrisperWhisper's mode tags. See the note
    // above MODELS in lib/models.ts; vad-regression-test.ts guards it.
    language: transcriptLanguage,
  };

  const rawWords: Word[] = [];
  const leadPadSamples = Math.floor(WHISPER_LEAD_PAD_S * VAD_SAMPLE_RATE);
  for (const seg of speechSegments) {
    const segmentSamples = seg.endSample - seg.startSample;
    // Copy into a fresh buffer with leading silence. Views with a non-zero
    // byteOffset have caused incomplete ASR with onnxruntime-web; starting
    // mid-speech with no lead-in also drops later speakers on mixed clips.
    const slice = new Float32Array(leadPadSamples + segmentSamples);
    slice.set(audio.subarray(seg.startSample, seg.endSample), leadPadSamples);
    const sliceDuration = slice.length / VAD_SAMPLE_RATE;
    const offsetS = seg.startSample / VAD_SAMPLE_RATE - WHISPER_LEAD_PAD_S;

    // Snapshot progress so a failed WebGPU attempt can be rolled back before
    // the WASM retry of this same segment.
    const partialBefore = partial;
    const progressBefore = { transcribed, chunkFloor, chunkTokens };

    const runSlice = async () => {
      // Each generate() window consumes `chunkLength - 2 * stride` seconds of
      // new audio, and the streamer's timestamps rewind to ~0 when the next
      // window starts. A timestamp lower than the last one seen marks that
      // boundary; accumulate the offset to recover segment-local time.
      const windowJumpS = chunkLength - 2 * stride;
      let windowOffsetS = 0;
      let lastChunkStartT = 0;
      const tokenizer = transcriber.tokenizer as ConstructorParameters<
        typeof WhisperTextStreamer
      >[0];
      const streamer = new WhisperTextStreamer(tokenizer, {
        skip_prompt: true,
        time_precision: timePrecision,
        on_chunk_start: (t: number) => {
          if (t < lastChunkStartT) windowOffsetS += windowJumpS;
          lastChunkStartT = t;
          reportProgress(
            Math.max(0, windowOffsetS + t - WHISPER_LEAD_PAD_S),
            segmentSamples
          );
        },
        callback_function: (text: string) => {
          partial += text;
          postPartial(partial);
          interpolateProgress();
        },
      });
      const output = await transcriber(slice, { ...asrOptions, streamer });
      const result = Array.isArray(output) ? output[0] : output;
      return (result.chunks ?? []) as AsrChunk[];
    };

    let chunks: AsrChunk[];
    try {
      chunks = await runSlice();
    } catch (err) {
      // Windows screen lock tears down WebGPU mid-OrtRun. Fall back to WASM
      // and retry this segment once so the job can finish.
      if (asrDevice !== "webgpu" || !isWebGpuDeviceLostError(err)) throw err;
      console.warn(
        "WebGPU lost during transcription (often after screen lock); falling back to WASM.",
        err
      );
      partial = partialBefore;
      transcribed = progressBefore.transcribed;
      chunkFloor = progressBefore.chunkFloor;
      chunkTokens = progressBefore.chunkTokens;
      postPartial(partial);
      await fallbackAsrToWasm();
      transcriber = await getAsr(choice);
      chunks = await runSlice();
    }

    const words = wordsFromChunks(chunks, offsetS, sliceDuration, duration);
    // A segment that decodes to nothing is the signature of a model or prompt
    // that has collapsed on this slice — the timeline fills with "..." VAD
    // placeholders and the transcript silently loses a stretch of speech. It is
    // indistinguishable from genuine silence downstream, so say so here, and
    // report enough to tell "ASR returned nothing" apart from "words were
    // produced and then dropped in post-processing".
    if (chunks.length === 0 || words.length === 0) {
      console.warn(
        `[asr] ${choice}: segment ${offsetS.toFixed(2)}s +${sliceDuration.toFixed(2)}s ` +
          `produced ${chunks.length} chunk(s) → ${words.length} word(s).`,
        chunks.length > 0
          ? { text: chunks.map((c) => c.text).join(""), chunks }
          : "(model returned no chunks)"
      );
    }
    rawWords.push(...words);
    speechDone += segmentSamples;
    reportProgress(0, 0);
  }

  await releaseAsr(choice);

  // Post-process: collapse leftover n-gram loops and drop known hallucination
  // phrases ("I'm sorry", "thanks for watching", …) that slip past decoding.
  const cleaned = cleanTranscript(rawWords);
  const words = await refineWordTimestamps(
    cleaned,
    speechFrames,
    audio,
    duration,
    transcriptLanguage
  );

  return finishWithDiarization(words, audio, onsetThreshold, maxSpeakers);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { audio, duration, model, language, maxSpeakers, onsetThreshold } = event.data;
  try {
    const choice: ModelId = model ?? "base";
    const transcriptLanguage: TranscriptLanguage = language ?? "en";
    const normalizedMaxSpeakers = Number.isFinite(maxSpeakers)
      ? Math.max(1, Math.round(Number(maxSpeakers)))
      : MAX_ALLOWED_SPEAKERS;
    const normalizedThreshold = Number.isFinite(onsetThreshold)
      ? Math.max(0, Math.min(1, Number(onsetThreshold)))
      : ONSET_THRESHOLD;

    let words: Word[];
    if (isParakeetModel(choice)) {
      words = await runParakeet(
        audio,
        duration,
        transcriptLanguage,
        normalizedMaxSpeakers,
        normalizedThreshold
      );
    } else if (isWhisperModel(choice)) {
      words = await runWhisper(
        audio,
        duration,
        choice,
        transcriptLanguage,
        normalizedMaxSpeakers,
        normalizedThreshold
      );
    } else {
      throw new Error(`Unknown speech model: ${String(choice)}`);
    }

    // Drop anything still queued: a stale "Transcribing… 99%" landing after
    // "complete" would put the UI back into its busy state.
    cancelLive();
    post({ type: "complete", words });
  } catch (err) {
    console.error(err);
    cancelLive();
    if (isNetworkError(err)) {
      // The retries in installFetchRetry are already spent by here, so this is
      // a connection that stayed down. "Failed to fetch" is what the browser
      // says and it means nothing to the person waiting on a transcript — name
      // the download, and say that the finished files are kept so a retry
      // resumes rather than starting the gigabyte over.
      post({
        type: "error",
        message:
          "Couldn't finish downloading the speech model — the connection " +
          "dropped. Check your internet and try again; the parts that " +
          "finished downloading are kept.",
        cause: "network",
      });
      return;
    }
    post({
      type: "error",
      message: isWebGpuDeviceLostError(err)
        ? "Transcription was interrupted when the GPU reset (often after locking the screen). Please try again."
        : err instanceof Error
          ? err.message
          : "Transcription failed.",
    });
  }
};
