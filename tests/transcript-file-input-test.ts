/**
 * Regression tests for importing a transcript through the "Import your own
 * transcript" file inputs (issue #105).
 *
 * The bug: the onChange handlers captured `input.files` and *then* cleared
 * `input.value`. `input.files` is a live `[SameObject]` FileList, so clearing
 * the input emptied the captured reference and the picked SRT/VTT/JSON was
 * dropped as if the user had cancelled — the pending transcript was never set,
 * so the app transcribed with Whisper instead of using the file.
 *
 * Run: npx tsx tests/transcript-file-input-test.ts
 */
import {
  isTranscriptFile,
  parseTranscriptFile,
  takeSelectedTranscriptFile,
} from "../lib/parseTranscript";
import { useEditorStore } from "../lib/store";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:04,000 --> 00:00:06,000
Alice: How are you?
`;

const VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
<v Ned>Winter is coming
`;

const JSON_TRANSCRIPT = JSON.stringify({
  words: [{ text: "One", start: 0, end: 0.4, speaker: "A" }],
});

/**
 * Stand-in for a file input that reproduces the browser behaviour this bug
 * depends on, measured in Chromium 130: `files` hands back the same live list
 * every time, and assigning `value` empties that very object.
 *
 * Node cannot build a real FileList, so the list is a plain array (whose
 * `length = 0` really does drop the entries, unlike deleting keys on an
 * object) behind an explicit cast.
 */
function fileInput(entries: Array<[string, string]>) {
  const list: File[] = [];
  let value = "";

  // Picking files sets the input's value to a fake path, exactly like the
  // browser does, without going through the value setter below.
  const pick = (items: Array<[string, string]> = entries) => {
    list.length = 0;
    for (const [name, body] of items) {
      list.push(new File([body], name, { type: "text/plain" }));
    }
    value = items.length > 0 ? `C:\\fakepath\\${items[0][0]}` : "";
  };
  pick();

  return {
    pick,
    get files(): FileList {
      return list as unknown as FileList;
    },
    get value() {
      return value;
    },
    /** Clearing the input resets both the path and the live list. */
    set value(next: string) {
      value = next;
      list.length = 0;
    },
  } as unknown as HTMLInputElement & {
    pick: (items?: Array<[string, string]>) => void;
  };
}

async function main() {
  {
    const input = fileInput([["a.srt", SRT]]);
    assert(input.files?.length === 1, "a picked file is visible on the input");
    assert(input.value !== "", "a picked file sets the input value");
  }

  // Control: this is the order the buggy handlers used, and it is why issue
  // #105 reports the file being ignored. If this ever stops losing the file,
  // the test double no longer models the browser and the checks below would
  // stop proving anything.
  {
    const input = fileInput([["c.srt", SRT]]);
    const captured = input.files; // const files = e.target.files
    input.value = ""; //             e.target.value = ""
    assert(
      captured?.length === 0 && captured?.[0] === undefined,
      "clearing the input empties an already-captured FileList"
    );
    console.log("clear-then-read control: ok (reproduces the reported bug)");
  }

  {
    const input = fileInput([["a.srt", SRT]]);
    const file = takeSelectedTranscriptFile(input);
    assert(file !== null, "srt: helper returns the picked file");
    assert(file?.name === "a.srt", `srt: file name ${file?.name}`);
    assert(input.value === "", "srt: helper resets the input for a re-pick");
    const parsed = await parseTranscriptFile(file as File);
    assert(parsed.words.length === 5, `srt: expected 5 words, got ${parsed.words.length}`);
    assert(parsed.words[0].text === "Hello", "srt: first word");
    console.log("srt import: ok");
  }

  {
    const input = fileInput([["b.vtt", VTT]]);
    const file = takeSelectedTranscriptFile(input);
    assert(file !== null, "vtt: helper returns the picked file");
    const parsed = await parseTranscriptFile(file as File);
    assert(parsed.words.length === 3, `vtt: expected 3 words, got ${parsed.words.length}`);
    assert(parsed.words[0].text === "Winter", "vtt: first word");
    console.log("vtt import: ok");
  }

  {
    const input = fileInput([["c.json", JSON_TRANSCRIPT]]);
    const file = takeSelectedTranscriptFile(input);
    assert(file !== null, "json: helper returns the picked file");
    assert(file !== null && isTranscriptFile(file), "json: accepted as a transcript");
    const parsed = await parseTranscriptFile(file as File);
    assert(parsed.words.length === 1, `json: expected 1 word, got ${parsed.words.length}`);
    console.log("json import: ok");
  }

  // The words a successful import hands to loadVideo are what makes the store
  // skip transcription, so an empty parse must never be treated as success.
  {
    const input = fileInput([["empty.srt", "   \n"]]);
    const file = takeSelectedTranscriptFile(input);
    assert(file !== null, "empty: file still returned");
    let threw = false;
    try {
      await parseTranscriptFile(file as File);
    } catch {
      threw = true;
    }
    assert(threw, "empty: an empty transcript must throw, not import nothing");
    console.log("empty transcript: ok");
  }

  // Cancelling the dialog fires no onChange, but if a handler does run with no
  // file it must be a no-op rather than leaving the UI mid-import.
  {
    const input = fileInput([]);
    assert(takeSelectedTranscriptFile(input) === null, "cancel: yields null");
    console.log("cancel: ok");
  }

  // Clearing the input is what allows picking the same file again.
  {
    const input = fileInput([["again.srt", SRT]]);
    const first = takeSelectedTranscriptFile(input);
    assert(first?.name === "again.srt", "re-pick: first selection");
    input.pick([["again.srt", SRT]]);
    const second = takeSelectedTranscriptFile(input);
    assert(second?.name === "again.srt", "re-pick: the same file can be picked again");
    console.log("re-pick: ok");
  }

  // Unsupported files reach the picker too; the helpers must hand them over so
  // the UI can show its invalid-file message instead of failing silently.
  {
    const input = fileInput([["notes.txt", "not a transcript"]]);
    const file = takeSelectedTranscriptFile(input);
    assert(file !== null, "invalid: helper returns the picked file");
    assert(file !== null && !isTranscriptFile(file), "invalid: rejected as a transcript");
    console.log("invalid file: ok");
  }

  // End to end, minus React: a picked transcript has to reach loadVideo, which
  // is the only thing that stops Whisper from running. This is the behaviour
  // issue #105 reports as missing.
  {
    const media = (name: string) => new File(["x"], name, { type: "video/mp4" });

    useEditorStore.getState().loadVideo(media("plain.mp4"));
    assert(
      useEditorStore.getState().skipTranscription === false,
      "no transcript picked: transcription still runs"
    );
    assert(useEditorStore.getState().words.length === 0, "no transcript picked: no words");

    const input = fileInput([["mycaptions.srt", SRT]]);
    const file = await parseTranscriptFile(takeSelectedTranscriptFile(input) as File);
    useEditorStore
      .getState()
      .loadVideo(media("captioned.mp4"), { words: file.words, speakers: file.speakers });

    const after = useEditorStore.getState();
    assert(after.skipTranscription === true, "imported transcript: transcription is skipped");
    assert(after.words.length === 5, `imported transcript: ${after.words.length} words loaded`);
    assert(after.source === "import", `imported transcript: source is ${after.source}`);
    console.log("no-Whisper path: ok");
  }

  console.log("ALL TRANSCRIPT FILE INPUT TESTS PASSED");
}

void main();
