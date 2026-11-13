import {
  DEFAULT_SILENCE_THRESHOLD,
  MAX_SILENCE_THRESHOLD,
  MIN_SILENCE_THRESHOLD,
  clampSilenceThreshold,
} from "../lib/silenceThreshold";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(clampSilenceThreshold(0.3) === 0.3, "in-range value is kept as-is");
assert(
  clampSilenceThreshold(0.05) === MIN_SILENCE_THRESHOLD,
  "below the floor clamps up to the floor"
);
assert(
  clampSilenceThreshold(5) === MAX_SILENCE_THRESHOLD,
  "above the ceiling clamps down to the ceiling"
);
assert(
  clampSilenceThreshold(MIN_SILENCE_THRESHOLD) === MIN_SILENCE_THRESHOLD,
  "the floor itself is kept"
);
assert(
  clampSilenceThreshold(MAX_SILENCE_THRESHOLD) === MAX_SILENCE_THRESHOLD,
  "the ceiling itself is kept"
);
assert(
  clampSilenceThreshold(Number.NaN) === DEFAULT_SILENCE_THRESHOLD,
  "NaN falls back to the default, not the floor"
);
assert(
  clampSilenceThreshold(Number.POSITIVE_INFINITY) === DEFAULT_SILENCE_THRESHOLD,
  "non-finite input falls back to the default"
);

console.log("ALL SILENCE THRESHOLD TESTS PASSED");
