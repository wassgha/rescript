# Patches

Applied by `patch-package` from `postinstall`. If a patch fails to apply, install
fails loudly rather than silently reverting to the buggy behaviour.

**Patched dependencies are pinned to an exact version in `package.json`, not a
caret range.** A patch filename carries the version it was cut against, and on a
mismatch `patch-package` only *warns* — so a range would let a minor bump quietly
drop the fix. That matters more than usual here, because neither unpatched
failure mode below announces itself: one is a silently truncated transcript, the
other an export that hangs forever instead of erroring. When bumping
`@huggingface/transformers`, re-cut the patch (`npx patch-package
@huggingface/transformers`) and re-run the CrisperWhisper models against a clip
containing a filler.

## `@huggingface/transformers` — bound the Whisper timestamp-token range

**Upstream bug.** `WhisperTokenizer` defines the start of the timestamp block as
`token_to_id("<|notimestamps|>") + 1`, and Whisper has exactly 1500 timestamp
tokens above it. `_decode_asr` uses both bounds:

```js
const timestamp_begin = this.timestamp_begin;
const total_timestamp_tokens = 1500;
const timestamp_end = timestamp_begin + total_timestamp_tokens;
```

Two other places test only the lower bound, so **every token above the timestamp
block is mistaken for a timestamp**:

1. `WhisperTokenizer.decodeWithTimestamps` — additionally re-derives the start as
   `all_special_ids.at(-1) + 1` rather than using the getter.
2. `WhisperTimeStampLogitsProcessor._call` — during generation.

For stock Whisper this is harmless: the vocabulary ends at the timestamp block,
so there is nothing above it to misclassify. It breaks any derivative that
extends the vocabulary.

**How it broke Rescript.** CrisperWhisper appends 31 tokens past the block —
`[UM]`, `[UH]`, 13 vocal events (`[laughter]`, `[breath]`, …) and its prompt
scaffolding. Two distinct failures, both triggered by the model transcribing a
filler:

- *Decoding.* `decodeWithTimestamps` split on `[UM]`, leaving an empty token
  bucket that reached `decode([])` — `token_ids must be a non-empty array of
  integers`, thrown from `combineTokensIntoWords` part-way through a transcript.
- *Generation.* The logits processor saw `[UH]` as a timestamp and ran
  `subarray(0, eos_token_id).fill(-Infinity)`, suppressing every text token and
  leaving only EOS. Transcription stopped at the first hesitation; the rest of
  the audio came back as `...` VAD placeholders.

The second one is the quieter of the two — no error, just a silently truncated
transcript. It is why CrisperWhisper appeared to *never* emit fillers through
transformers.js while emitting them readily in PyTorch: asking for word
timestamps suppressed the very tokens the model was chosen for.

**The patch.** Adds `timestamp_end = timestamp_begin + 1500` alongside the
existing lower bound and range-checks against both, matching what `_decode_asr`
already does. Also:

- makes `decodeWithTimestamps` use the `timestamp_begin` getter instead of
  re-deriving it from `all_special_ids`;
- skips empty buckets in its output map (a leading or doubled timestamp produces
  one even on stock Whisper — a latent crash);
- when forcing a timestamp, suppresses text tokens *above* the block too, not
  just below it;
- compares against the max text-token logprob on both sides of the block.

**Upstreaming.** Worth a PR — the fix is small and the tokenizer already computes
the correct bound. Until then this patch is required for the CrisperWhisper
entries in `lib/models.ts` to work at all.

## `@ffmpeg/ffmpeg` — reject in-flight calls when the worker dies

**Upstream bug.** `FFmpeg` tracks every request in `#resolves` / `#rejects` keyed
by message id, and the only thing that ever settles them is a reply from the
worker. `#registerHandlers` installs `worker.onmessage` and nothing else — no
`onerror`, no `onmessageerror`. The worker's own `self.onmessage` has a
`try`/`catch` that posts an `ERROR` reply, so *synchronous* failures on the
worker's message thread do report back. Everything else does not:

- an emscripten `pthread` trapping (the multi-threaded core runs the filtergraph
  and x264 on real threads, and their errors do not surface on the class
  worker's message thread);
- the browser killing the worker under memory pressure;
- any async rejection outside the awaited path.

In all three the promise stays pending forever. `FFmpeg.terminate()` is the only
code that clears `#rejects`, and a caller stuck awaiting `exec()` never gets to
call it.

**How it broke Rescript.** Export sat at "Rendering in your browser… 0%"
indefinitely with no error — the dialog has no timeout of its own, so the run
never ended and never failed. The underlying crash *was* reaching Sentry as an
unhandled `RuntimeError: memory access out of bounds`, tagged to no stage,
because it never travelled through any of our `catch` blocks.

**The patch.** Adds `#failAllPending(reason)` and wires it to `worker.onerror`
and `worker.onmessageerror`, so a dead worker rejects every outstanding call
instead of stranding it. It deliberately does *not* `preventDefault()` the error
event — the crash should still reach the global handler so Sentry keeps seeing
it.

This covers the class worker dying. A trap inside a nested emscripten pthread
does not bubble to the parent `Worker`, so `lib/ffmpeg.ts` also runs a liveness
watchdog over `exec()`; see the comment on `execWithWatchdog` there.

**Follow-up (export memory).** The watchdog stops the hang; it does not raise
the 1 GiB ceiling. Video/audio export now loads the single-threaded
`@ffmpeg/core` (growable up to 2 GiB) from `/vendor/ffmpeg-st/`, while audio
extraction still prefers `@ffmpeg/core-mt` and falls back to the growable core
when the 1 GiB `SharedArrayBuffer` cannot be reserved. That is what made
desktop-app 1080p/original export fail with "ffmpeg not starting" while the
same project exported in the browser.

**Upstreaming.** Worth a PR — this is a bug in any consumer, not something
specific to Rescript.
