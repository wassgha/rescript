/**
 * Minimal reader / writer for Blender 5.x `.blend` files (uncompressed,
 * little-endian, 64-bit "large BHead" format).
 *
 * A .blend is a header followed by blocks: each has a 4-char code, the struct
 * type it holds (index into the file's own SDNA), the memory address it was
 * saved from, and its raw bytes. Pointers inside a block are stored as those
 * saved addresses. Blender resolves a DATA block only through the ID block it
 * follows, so blocks belonging to an ID must stay inside that ID's run.
 */

const HEADER = "BLENDER17-01v";
const HEADER_LENGTH = 17;
const BHEAD_LENGTH = 32;
const POINTER_SIZE = 8;

export interface BlendBlock {
  code: string;
  sdna: number;
  old: bigint;
  nr: number;
  data: Uint8Array;
}

interface SdnaField {
  /** Field name without pointer stars or array dimensions. */
  name: string;
  type: string;
  offset: number;
  size: number;
  pointer: boolean;
  count: number;
}

function readStrings(data: Uint8Array, view: DataView, offset: number, tag: string) {
  const got = String.fromCharCode(...data.subarray(offset, offset + 4));
  if (got !== tag) throw new Error(`Unexpected SDNA section ${got}, wanted ${tag}`);
  const count = view.getInt32(offset + 4, true);
  let o = offset + 8;
  const out: string[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const end = data.indexOf(0, o);
    out.push(decoder.decode(data.subarray(o, end)));
    o = end + 1;
  }
  return { strings: out, next: (o + 3) & ~3 };
}

export class Sdna {
  private readonly structs = new Map<string, SdnaField[]>();
  private readonly typeSizes = new Map<string, number>();
  readonly structNames: string[] = [];

  constructor(block: Uint8Array) {
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    if (String.fromCharCode(...block.subarray(0, 4)) !== "SDNA") {
      throw new Error("Missing SDNA");
    }
    const names = readStrings(block, view, 4, "NAME");
    const types = readStrings(block, view, names.next, "TYPE");
    let o = types.next;
    if (String.fromCharCode(...block.subarray(o, o + 4)) !== "TLEN") {
      throw new Error("Missing TLEN");
    }
    o += 4;
    types.strings.forEach((t, i) => this.typeSizes.set(t, view.getInt16(o + i * 2, true)));
    o = (o + types.strings.length * 2 + 3) & ~3;
    if (String.fromCharCode(...block.subarray(o, o + 4)) !== "STRC") {
      throw new Error("Missing STRC");
    }
    const structCount = view.getInt32(o + 4, true);
    o += 8;
    for (let i = 0; i < structCount; i++) {
      const type = types.strings[view.getInt16(o, true)];
      const fieldCount = view.getInt16(o + 2, true);
      o += 4;
      const fields: SdnaField[] = [];
      let offset = 0;
      for (let f = 0; f < fieldCount; f++) {
        const fieldType = types.strings[view.getInt16(o, true)];
        const rawName = names.strings[view.getInt16(o + 2, true)];
        o += 4;
        const pointer = rawName.startsWith("*") || rawName.startsWith("(*");
        let count = 1;
        for (const m of rawName.matchAll(/\[(\d+)\]/g)) count *= Number(m[1]);
        const name = rawName.replace(/\[.*$/, "").replace(/[*()]/g, "");
        const size = (pointer ? POINTER_SIZE : this.typeSizes.get(fieldType) ?? 0) * count;
        fields.push({ name, type: fieldType, offset, size, pointer, count });
        offset += size;
      }
      this.structs.set(type, fields);
      this.structNames.push(type);
    }
  }

  sizeOf(type: string): number {
    const size = this.typeSizes.get(type);
    if (size === undefined) throw new Error(`Unknown SDNA type ${type}`);
    return size;
  }

  fields(type: string): SdnaField[] {
    const fields = this.structs.get(type);
    if (!fields) throw new Error(`Unknown SDNA struct ${type}`);
    return fields;
  }

  /** Resolve a dotted path through embedded structs, e.g. `r.frs_sec`. */
  field(type: string, path: string): SdnaField {
    let offset = 0;
    let current = type;
    let found: SdnaField | undefined;
    for (const part of path.split(".")) {
      found = this.fields(current).find((f) => f.name === part);
      if (!found) throw new Error(`No field ${current}.${part}`);
      offset += found.offset;
      current = found.type;
    }
    return { ...found!, offset };
  }

  /**
   * Every pointer slot in `type`, recursing into embedded structs. `owner` is
   * the struct that directly declares the pointer (e.g. `ListBase`).
   */
  *pointers(
    type: string,
    base = 0
  ): Generator<{ offset: number; name: string; owner: string }> {
    for (const f of this.fields(type)) {
      if (f.pointer) {
        for (let k = 0; k < f.count; k++) {
          yield { offset: base + f.offset + k * POINTER_SIZE, name: f.name, owner: type };
        }
      } else if (this.structs.has(f.type)) {
        const size = this.sizeOf(f.type);
        for (let k = 0; k < f.count; k++) {
          yield* this.pointers(f.type, base + f.offset + k * size);
        }
      }
    }
  }
}

export class BlendFile {
  header: Uint8Array;
  blocks: BlendBlock[];
  readonly sdna: Sdna;

  constructor(buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer);
    const header = String.fromCharCode(...bytes.subarray(0, HEADER_LENGTH));
    if (!header.startsWith(HEADER)) {
      throw new Error(`Not an uncompressed Blender 5 file (${header})`);
    }
    this.header = bytes.slice(0, HEADER_LENGTH);
    const view = new DataView(buffer);
    this.blocks = [];
    let o = HEADER_LENGTH;
    for (;;) {
      if (o + BHEAD_LENGTH > bytes.byteLength) throw new Error("Truncated .blend");
      const code = String.fromCharCode(...bytes.subarray(o, o + 4)).replace(/\0+$/, "");
      const sdna = view.getInt32(o + 4, true);
      const old = view.getBigUint64(o + 8, true);
      const len = Number(view.getBigInt64(o + 16, true));
      const nr = Number(view.getBigInt64(o + 24, true));
      o += BHEAD_LENGTH;
      this.blocks.push({ code, sdna, old, nr, data: bytes.slice(o, o + len) });
      o += len;
      if (code === "ENDB") break;
    }
    const dna = this.blocks.find((b) => b.code === "DNA1");
    if (!dna) throw new Error("Missing DNA1 block");
    this.sdna = new Sdna(dna.data);
  }

  typeOf(block: BlendBlock): string {
    return this.sdna.structNames[block.sdna];
  }

  /** Map from saved address to block. */
  byAddress(): Map<bigint, BlendBlock> {
    const map = new Map<bigint, BlendBlock>();
    for (const b of this.blocks) if (b.old !== BigInt(0)) map.set(b.old, b);
    return map;
  }

  serialize(): Blob {
    const parts: BlobPart[] = [this.header as Uint8Array<ArrayBuffer>];
    for (const b of this.blocks) {
      const head = new Uint8Array(BHEAD_LENGTH);
      const view = new DataView(head.buffer);
      for (let i = 0; i < 4; i++) head[i] = b.code.charCodeAt(i) || 0;
      view.setInt32(4, b.sdna, true);
      view.setBigUint64(8, b.old, true);
      view.setBigInt64(16, BigInt(b.data.byteLength), true);
      view.setBigInt64(24, BigInt(b.nr), true);
      parts.push(head, b.data as Uint8Array<ArrayBuffer>);
    }
    return new Blob(parts, { type: "application/x-blender" });
  }
}

/** Typed access to one struct instance inside a block. */
export class StructView {
  private readonly view: DataView;

  constructor(
    private readonly sdna: Sdna,
    readonly type: string,
    readonly block: BlendBlock
  ) {
    this.view = new DataView(block.data.buffer, block.data.byteOffset, block.data.byteLength);
  }

  private at(path: string, kind: string) {
    const f = this.sdna.field(this.type, path);
    if (f.pointer ? kind !== "ptr" : !f.type.includes(kind) && kind !== "str") {
      throw new Error(`${this.type}.${path} is ${f.pointer ? "a pointer" : f.type}, not ${kind}`);
    }
    return f.offset;
  }

  getInt(path: string): number {
    return this.view.getInt32(this.at(path, "int"), true);
  }
  setInt(path: string, v: number): void {
    this.view.setInt32(this.at(path, "int"), v, true);
  }
  getShort(path: string): number {
    return this.view.getInt16(this.at(path, "short"), true);
  }
  setShort(path: string, v: number): void {
    this.view.setInt16(this.at(path, "short"), v, true);
  }
  getFloat(path: string): number {
    return this.view.getFloat32(this.at(path, "float"), true);
  }
  setFloat(path: string, v: number): void {
    this.view.setFloat32(this.at(path, "float"), v, true);
  }
  getPointer(path: string): bigint {
    return this.view.getBigUint64(this.at(path, "ptr"), true);
  }
  setPointer(path: string, v: bigint): void {
    this.view.setBigUint64(this.at(path, "ptr"), v, true);
  }
  getString(path: string): string {
    const f = this.sdna.field(this.type, path);
    const bytes = this.block.data.subarray(f.offset, f.offset + f.size);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
  }
  /** Write a NUL-terminated UTF-8 string into a fixed `char[]`; throws if it doesn't fit. */
  setString(path: string, value: string): void {
    const f = this.sdna.field(this.type, path);
    if (f.type !== "char" || f.pointer) throw new Error(`${this.type}.${path} is not char[]`);
    const encoded = new TextEncoder().encode(value);
    if (encoded.byteLength >= f.size) {
      throw new Error(`"${value}" is too long for ${this.type}.${path} (${f.size - 1} bytes)`);
    }
    const target = this.block.data.subarray(f.offset, f.offset + f.size);
    target.fill(0);
    target.set(encoded);
  }
}

/** Longest prefix of `value` whose UTF-8 encoding fits in `maxBytes`. */
export function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let out = "";
  for (const ch of value) {
    if (encoder.encode(out + ch).byteLength > maxBytes) break;
    out += ch;
  }
  return out;
}
