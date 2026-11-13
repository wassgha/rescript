/**
 * Build a Blender (5.2+) Video Sequencer project from the editor's keep
 * ranges by patching the vendored scaffold (assets/blend/scaffold.blend).
 *
 * The scaffold is Blender's Video Editing startup file with one movie strip
 * and one sound strip (see scripts/generate-blend-scaffold.py). Each keep range
 * gets a clone of those strips, linked to the original media by name relative
 * to the .blend (`//<file name>`), so the project must sit next to the source.
 *
 * The timeline mirrors the rendered export: video keeps exactly the frames
 * ffmpeg's `trim` keeps, and each clip starts where ffmpeg's `concat` starts
 * it — once the longer of its video and audio has ended — rounded to a whole
 * frame. Where the audio outlasts the frames, the render holds the last frame;
 * so does a hold strip here. Blender cuts audio on whole frames only, so each
 * sound strip starts exactly on the cut (shifted by a sub-frame sound offset)
 * and stops on the last frame boundary before its cut-out: deleted audio is
 * never played, at the cost of under a frame of kept audio at each cut-out.
 */

import { BlendFile, StructView, truncateUtf8, type BlendBlock } from "./blendFile";
import type { FrameRate } from "../exportArgs";
import type { TimeRange } from "../types";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const SCAFFOLD_URL = `${BASE_PATH}/vendor/blend/scaffold.blend`;

/** Must match scripts/generate-blend-scaffold.py */
const MOVIE_STRIP = "SQRESCRIPT_V";
const SOUND_STRIP = "SQRESCRIPT_A";
const VIDEO_CHANNEL = 2;
const AUDIO_CHANNEL = 1;

/** Audio-only projects have no frame rate; on a 1 ms grid every cut lands on a frame. */
const AUDIO_ONLY_FRAME_RATE: FrameRate = { num: 1000, den: 1 };

/** Pointer fields that link strips together rather than to data they own. */
const LINK_POINTERS = new Set(["next", "prev", "seq1", "seq2", "seq3"]);

export interface BlendExportInput {
  keepRanges: TimeRange[];
  /** Original media duration in seconds. */
  duration: number;
  mediaFileName: string;
  /** The source video's frame rate; ignored without video. */
  frameRate: FrameRate;
  withVideo: boolean;
  withAudio: boolean;
  width: number;
  height: number;
}

export interface BlendStripPlan {
  /** First source frame kept. */
  sourceIn: number;
  /** One past the last source frame kept (equal to sourceIn for a keep holding no frame). */
  sourceOut: number;
  /** Timeline frame the clip's video starts on (the scene starts at frame 1). */
  timelineStart: number;
  /** Frames the clip's last frame is held until the next clip's video. */
  holdFrames: number;
  /** Source position (fractional frame) of the cut the audio starts on. */
  soundIn: number;
  /** Whole frames of audio, starting with the clip. */
  soundFrames: number;
}

export interface BlendTimelinePlan {
  clips: BlendStripPlan[];
  /** Timeline length in frames. */
  frames: number;
}

/**
 * Frame-accurate placement of each keep range, mirroring buildVideoExport.
 * The cut times are rounded to milliseconds as ffmpeg receives them; `trim`
 * keeps the frames whose timestamp t satisfies start ≤ t < end, never past the
 * source's last frame; `concat` starts each segment when the longer of its
 * streams ends, and the encoder rounds that onto the output frame grid.
 */
export function planBlendStrips(
  keepRanges: TimeRange[],
  rate: FrameRate,
  sourceFrames: number,
  withAudio: boolean
): BlendTimelinePlan {
  const fps = rate.num / rate.den;
  const firstFrameAtOrAfter = (seconds: number) => Math.ceil(seconds * fps - 1e-6);
  const clips: BlendStripPlan[] = [];
  let elapsed = 0; // concat's output position, in fractional frames
  for (const r of keepRanges) {
    const start = Number(r.start.toFixed(3));
    const end = Number(r.end.toFixed(3));
    const sourceIn = Math.max(0, firstFrameAtOrAfter(start));
    const sourceOut = Math.max(sourceIn, Math.min(sourceFrames, firstFrameAtOrAfter(end)));
    const frames = sourceOut - sourceIn;
    const audioFrames = withAudio ? (end - start) * fps : 0;
    if (frames === 0 && audioFrames <= 0) continue;
    clips.push({
      sourceIn,
      sourceOut,
      timelineStart: 1 + Math.round(elapsed + 1e-6),
      holdFrames: 0,
      soundIn: start * fps,
      soundFrames: Math.floor(audioFrames + 1e-6),
    });
    elapsed += Math.max(frames, audioFrames);
  }
  const length = Math.ceil(elapsed - 1e-6);
  // Each clip's last frame stays up until the next clip with video starts.
  let nextVideo = 1 + length;
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    if (c.sourceOut === c.sourceIn) continue;
    const videoEnd = c.timelineStart + c.sourceOut - c.sourceIn;
    c.holdFrames = Math.max(0, nextVideo - videoEnd);
    nextVideo = c.timelineStart;
  }
  return { clips, frames: length };
}

/** Blender stores fps as an integer rate over a float base. */
export function blenderFps(rate: FrameRate): { fps: number; base: number } {
  const fps = Math.max(1, Math.min(32767, Math.round(rate.num / rate.den)));
  return { fps, base: (fps * rate.den) / rate.num };
}

let scaffoldPromise: Promise<ArrayBuffer> | null = null;

async function loadScaffold(): Promise<ArrayBuffer> {
  if (!scaffoldPromise) {
    scaffoldPromise = fetch(SCAFFOLD_URL)
      .then((r) => {
        if (!r.ok) throw new Error("Could not load the Blender export template.");
        return r.arrayBuffer();
      })
      .catch((err) => {
        scaffoldPromise = null;
        throw err;
      });
  }
  return scaffoldPromise;
}

class Patcher {
  private readonly byAddress: Map<bigint, BlendBlock>;
  private nextAddress: bigint;

  constructor(readonly file: BlendFile) {
    this.byAddress = file.byAddress();
    let max = BigInt(0);
    for (const a of this.byAddress.keys()) if (a > max) max = a;
    this.nextAddress = max + BigInt(0x1000);
  }

  view(type: string, block: BlendBlock) {
    return new StructView(this.file.sdna, type, block);
  }

  private pointerAt(block: BlendBlock, offset: number): bigint {
    return new DataView(block.data.buffer, block.data.byteOffset).getBigUint64(offset, true);
  }

  private setPointerAt(block: BlendBlock, offset: number, value: bigint) {
    new DataView(block.data.buffer, block.data.byteOffset).setBigUint64(offset, value, true);
  }

  /** Pointer slots of `block` that point at DATA it owns (or at nothing saved). */
  private *ownedPointers(block: BlendBlock) {
    const type = this.file.typeOf(block);
    const size = this.file.sdna.sizeOf(type);
    for (let i = 0; i < block.nr; i++) {
      for (const p of this.file.sdna.pointers(type, i * size)) {
        if (LINK_POINTERS.has(p.name)) continue;
        const value = this.pointerAt(block, p.offset);
        if (value === BigInt(0)) continue;
        if (p.owner === "ListBase") {
          throw new Error(`Blender scaffold strip has a non-empty list (${type})`);
        }
        const target = this.byAddress.get(value);
        if (target && target.code !== "DATA") continue; // shared ID datablock
        yield { offset: p.offset, target };
      }
    }
  }

  /** The block and every DATA block it owns, transitively. */
  ownedClosure(block: BlendBlock, into = new Set<BlendBlock>()): Set<BlendBlock> {
    into.add(block);
    for (const { target } of this.ownedPointers(block)) {
      if (target && !into.has(target)) this.ownedClosure(target, into);
    }
    return into;
  }

  /** Deep-copy a block and the DATA it owns under fresh addresses. */
  clone(block: BlendBlock, out: BlendBlock[]): BlendBlock {
    const copy: BlendBlock = { ...block, data: block.data.slice(), old: this.allocate() };
    out.push(copy);
    this.byAddress.set(copy.old, copy);
    for (const { offset, target } of this.ownedPointers(block)) {
      // Unsaved runtime pointers have no block; Blender expects them cleared.
      this.setPointerAt(copy, offset, target ? this.clone(target, out).old : BigInt(0));
    }
    return copy;
  }

  /** The block saved at `address` (scaffold or clone). */
  block(address: bigint): BlendBlock {
    const b = this.byAddress.get(address);
    if (!b) throw new Error("Dangling pointer in Blender scaffold");
    return b;
  }

  private allocate(): bigint {
    this.nextAddress += BigInt(0x10);
    return this.nextAddress;
  }
}

type StripKind = "video" | "hold" | "audio";

function stripName(fileName: string, index: number, kind: StripKind): string {
  const suffix = ` ${index + 1}${kind === "video" ? "" : ` ${kind}`}`;
  // Sequence.name is char[64] and carries the 2-byte "SQ" ID-style prefix.
  return truncateUtf8(fileName, 63 - 2 - suffix.length) + suffix;
}

export async function writeBlendProject(input: BlendExportInput): Promise<Blob> {
  const { keepRanges, duration, mediaFileName, withVideo, withAudio, width, height } = input;
  if (keepRanges.length === 0) {
    throw new Error("Everything has been deleted — nothing to export.");
  }
  if (!withVideo && !withAudio) {
    throw new Error("Nothing to put on the timeline.");
  }

  const file = new BlendFile(await loadScaffold());
  const patcher = new Patcher(file);
  const findStrip = (name: string) => {
    const block = file.blocks.find(
      (b) =>
        b.code === "DATA" &&
        file.typeOf(b) === "Sequence" &&
        patcher.view("Sequence", b).getString("name") === name
    );
    if (!block) throw new Error(`Blender scaffold is missing ${name}`);
    return block;
  };
  const movieTemplate = findStrip(MOVIE_STRIP);
  const soundTemplate = findStrip(SOUND_STRIP);
  const scene = file.blocks.find((b) => b.code === "SC");
  const sound = file.blocks.find((b) => b.code === "SO");
  const editing = file.blocks.find((b) => b.code === "DATA" && file.typeOf(b) === "Editing");
  if (!scene || !sound || !editing) throw new Error("Unexpected Blender scaffold");

  const rate = withVideo ? input.frameRate : AUDIO_ONLY_FRAME_RATE;
  const fps = rate.num / rate.den;
  const sourceFrames = Math.max(1, Math.round(duration * fps));
  const { clips, frames: timelineFrames } = planBlendStrips(
    keepRanges,
    rate,
    sourceFrames,
    withAudio
  );
  const linkedPath = `//${mediaFileName}`;

  const created: BlendBlock[] = [];
  const strips: BlendBlock[] = [];
  const addStrip = (
    kind: StripKind,
    index: number,
    span: { len: number; start: number; sourceIn: number; frames: number }
  ) => {
    const block = patcher.clone(kind === "audio" ? soundTemplate : movieTemplate, created);
    strips.push(block);
    const s = patcher.view("Sequence", block);
    s.setString("name", `SQ${stripName(mediaFileName, index, kind)}`);
    // Blender places a strip's content on a whole frame; a sound strip's
    // sub-frame remainder goes into its sound offset instead.
    const contentStart = Math.floor(span.start - span.sourceIn + 1e-6);
    const startofs = span.start - contentStart;
    s.setInt("len", span.len);
    s.setFloat("start", contentStart);
    s.setFloat("startofs", startofs);
    s.setFloat("endofs", span.len - startofs - span.frames);
    s.setInt("startdisp", span.start);
    s.setInt("enddisp", span.start + span.frames);
    s.setInt("machine", kind === "audio" ? AUDIO_CHANNEL : VIDEO_CHANNEL);
    // Media sits next to the .blend; also clears the scaffold's temp folder.
    const strip = patcher.view("Strip", patcher.block(s.getPointer("strip")));
    strip.setString("dir", "//");
    if (kind !== "audio") {
      s.setFloat("media_playback_rate", fps);
      const elem = patcher.view("StripElem", patcher.block(strip.getPointer("stripdata")));
      elem.setString("name", mediaFileName);
      elem.setInt("orig_width", width);
      elem.setInt("orig_height", height);
      elem.setFloat("orig_fps", fps);
    } else {
      s.setFloat("sound_offset", (startofs - span.sourceIn) / fps);
    }
  };
  clips.forEach((clip, index) => {
    const frames = clip.sourceOut - clip.sourceIn;
    if (withVideo && frames > 0) {
      addStrip("video", index, {
        len: sourceFrames,
        start: clip.timelineStart,
        sourceIn: clip.sourceIn,
        frames,
      });
      if (clip.holdFrames > 0) {
        // Content cut off after the last kept frame: Blender holds a strip's
        // last frame when the strip runs past its content.
        addStrip("hold", index, {
          len: clip.sourceOut,
          start: clip.timelineStart + frames,
          sourceIn: clip.sourceOut - 1,
          frames: clip.holdFrames,
        });
      }
    }
    if (withAudio && clip.soundFrames > 0) {
      addStrip("audio", index, {
        len: sourceFrames,
        start: clip.timelineStart,
        sourceIn: clip.soundIn,
        frames: clip.soundFrames,
      });
    }
  });

  if (strips.length === 0) {
    throw new Error("Everything has been deleted — nothing to export.");
  }
  strips.forEach((block, i) => {
    const s = patcher.view("Sequence", block);
    s.setPointer("prev", i > 0 ? strips[i - 1].old : BigInt(0));
    s.setPointer("next", i + 1 < strips.length ? strips[i + 1].old : BigInt(0));
  });
  const ed = patcher.view("Editing", editing);
  ed.setPointer("seqbase.first", strips[0].old);
  ed.setPointer("seqbase.last", strips[strips.length - 1].old);
  ed.setPointer("act_seq", BigInt(0));

  // The template's file browsers remember the folder the scaffold was made in.
  for (const b of file.blocks) {
    if (b.code === "DATA" && file.typeOf(b) === "FileSelectParams") {
      patcher.view("FileSelectParams", b).setString("dir", "");
    }
  }

  const sc = patcher.view("Scene", scene);
  const { fps: rateInt, base } = blenderFps(rate);
  sc.setShort("r.frs_sec", rateInt);
  sc.setFloat("r.frs_sec_base", base);
  if (withVideo) {
    sc.setInt("r.xsch", width);
    sc.setInt("r.ysch", height);
  }
  sc.setInt("r.sfra", 1);
  sc.setInt("r.efra", timelineFrames);

  const removed = new Set<BlendBlock>([
    ...patcher.ownedClosure(movieTemplate),
    ...patcher.ownedClosure(soundTemplate),
  ]);
  if (withAudio) {
    const snd = patcher.view("bSound", sound);
    snd.setString("name", linkedPath);
    snd.setString("id.name", `SO${truncateUtf8(mediaFileName, 255)}`);
  } else {
    // Drop the unused sound datablock along with the DATA blocks it owns.
    const at = file.blocks.indexOf(sound);
    removed.add(sound);
    for (let i = at + 1; i < file.blocks.length && file.blocks[i].code === "DATA"; i++) {
      removed.add(file.blocks[i]);
    }
  }

  // Clones go where the template strips were: inside the scene's DATA run.
  const blocks: BlendBlock[] = [];
  for (const b of file.blocks) {
    if (b === movieTemplate) blocks.push(...created);
    if (!removed.has(b)) blocks.push(b);
  }
  file.blocks = blocks;
  return file.serialize();
}
