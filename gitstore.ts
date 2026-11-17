// gitstore.ts — the git object model and packfile codec, written from the git wire format:
// SHA-1 addressed objects (commit/tree/blob/tag), pkt-lines, pack v2 read/write with
// OFS_DELTA and REF_DELTA resolution. Node standard library only (node:crypto, node:zlib).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The SHA-1 of an object: sha1("<type> <size>\0" + data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ------------------------------------------------------------------------------------------------
// Trees and commits.
// ------------------------------------------------------------------------------------------------

export interface TreeEntry {
  /** '100644', '100755', '120000', '40000' (directory), '160000' — as stored, directories lose the leading 0. */
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: byte-wise by name, with directory names compared as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. Headers the forge does not model are ignored, bytes are kept verbatim elsewhere. */
export function parseCommit(data: Buffer): CommitInfo {
  const blank = data.indexOf('\n\n');
  const head = data.toString('utf8', 0, blank < 0 ? data.length : blank);
  const message = blank < 0 ? '' : data.toString('utf8', blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialize a commit in git's canonical header order (tree, parents, author, committer, blank, message). */
export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's bytes. */
export function parseTag(data: Buffer): TagInfo {
  const blank = data.indexOf('\n\n');
  const head = data.toString('utf8', 0, blank < 0 ? data.length : blank);
  const message = blank < 0 ? '' : data.toString('utf8', blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ------------------------------------------------------------------------------------------------
// pkt-lines: 4 hex digits of total length (header included), 0000 flush, 0001 delim, 0002 end.
// ------------------------------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new Error(`pkt-line payload too large: ${data.length}`);
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode as many complete pkt-lines as `buffer` holds from `offset`.
 * Returns the packets and the offset just past the last complete one; a trailing partial
 * packet is left unconsumed (its bytes stay for the caller to reject or complete).
 */
export function decodePkts(buffer: Buffer, offset = 0): { packets: Pkt[]; next: number } {
  const packets: Pkt[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const head = buffer.toString('ascii', at, at + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, next: at };
}

// ------------------------------------------------------------------------------------------------
// Packfiles.
// ------------------------------------------------------------------------------------------------

/** Write a pack v2 of plain (non-delta) objects, with the SHA-1 trailer. */
export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodePackObjectHeader(TYPE_TO_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function encodePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Inflate one zlib stream starting at `offset`, finding its exact end. The fast path
 * inflates the tail in a single call: inflateSync ignores bytes past the stream's end,
 * and with `{ info: true }` the engine reports exactly how many input bytes the stream
 * consumed (`bytesWritten`), so one call replaces the old exponential probe plus
 * bisection (about eleven inflate calls, most of them throwing on truncated input).
 * When the engine's count is not plausible, the old probing path runs instead.
 */
function inflateExact(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const remaining = buffer.length - offset;
  try {
    const out = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten?: unknown };
    };
    const consumed = out.engine?.bytesWritten;
    if (
      typeof consumed === 'number' &&
      Number.isInteger(consumed) &&
      consumed > 0 &&
      consumed <= remaining
    ) {
      return { data: out.buffer, next: offset + consumed };
    }
  } catch {
    // A truncated or corrupt stream: fall through to the probing path, which
    // raises the same failure the old code raised.
  }
  const attempt = (length: number): Buffer | null => {
    try {
      return inflateSync(buffer.subarray(offset, offset + length));
    } catch {
      return null;
    }
  };
  let hi = Math.min(remaining, 1024);
  let found = attempt(hi);
  while (found === null && hi < remaining) {
    hi = Math.min(remaining, hi * 4);
    found = attempt(hi);
  }
  if (found === null) throw new Error('pack object does not inflate');
  let lo = 1;
  let high = hi;
  while (lo < high) {
    const mid = Math.floor((lo + high) / 2);
    if (attempt(mid) !== null) high = mid;
    else lo = mid + 1;
  }
  const data = attempt(lo);
  if (data === null) throw new Error('pack object does not inflate');
  return { data, next: offset + lo };
}

/** Apply a git delta (copy/insert program) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset |= delta[offset] ?? 0; offset += 1; }
      if (op & 0x02) { copyOffset |= (delta[offset] ?? 0) << 8; offset += 1; }
      if (op & 0x04) { copyOffset |= (delta[offset] ?? 0) << 16; offset += 1; }
      if (op & 0x08) { copyOffset |= (delta[offset] ?? 0) << 24; offset += 1; }
      if (op & 0x10) { copySize |= delta[offset] ?? 0; offset += 1; }
      if (op & 0x20) { copySize |= (delta[offset] ?? 0) << 8; offset += 1; }
      if (op & 0x40) { copySize |= (delta[offset] ?? 0) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

export interface PackRead {
  /** Every object in the pack, deltas resolved, keyed by its SHA-1. */
  objects: Map<string, GitObj>;
  /** Bytes consumed from the start offset, trailer included. */
  bytesRead: number;
  /** Whether the pack's SHA-1 trailer matches its content. */
  checksumOk: boolean;
}

/**
 * Read a pack starting at `start`. `external` resolves REF_DELTA bases that live outside the
 * pack (a thin pack against the repository's own objects); it is never needed for the packs
 * this forge writes, but receive-pack accepts what a client sends.
 */
export function readPack(
  buffer: Buffer,
  start = 0,
  external?: (oid: string) => GitObj | undefined,
): PackRead {
  if (buffer.length - start < 12 + 20) throw new Error('pack is too short');
  if (buffer.toString('ascii', start, start + 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(start + 4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(start + 8);
  let offset = start + 12;

  interface RawEntry {
    type: ObjType;
    data: Buffer;
    /** Byte offset of this entry's header inside the pack, for OFS_DELTA bases. */
    entryOffset: number;
  }
  const rawByOffset = new Map<number, RawEntry>();
  const pending: Array<{ entryOffset: number; kind: 'ofs' | 'ref'; baseOffset?: number; baseOid?: string; delta: Buffer }> = [];

  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset - start;
    let byte = buffer[offset] ?? 0;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    // The header's declared size: the low nibble first, then 7 bits a byte,
    // little-endian. The inflate below must produce exactly this many bytes.
    let declaredSize = byte & 0x0f;
    let sizeShift = 4;
    while (byte & 0x80) {
      byte = buffer[offset] ?? 0;
      offset += 1;
      declaredSize += (byte & 0x7f) * 2 ** sizeShift;
      sizeShift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry, in git's offset encoding.
      byte = buffer[offset] ?? 0;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buffer[offset] ?? 0;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const inflated = inflateExact(buffer, offset);
      offset = inflated.next;
      if (inflated.data.length !== declaredSize) throw new Error('pack object size mismatch');
      pending.push({ entryOffset, kind: 'ofs', baseOffset: entryOffset - baseOffset, delta: inflated.data });
    } else if (typeCode === 7) {
      const baseOid = buffer.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateExact(buffer, offset);
      offset = inflated.next;
      if (inflated.data.length !== declaredSize) throw new Error('pack object size mismatch');
      pending.push({ entryOffset, kind: 'ref', baseOid, delta: inflated.data });
    } else {
      const type = CODE_TO_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateExact(buffer, offset);
      offset = inflated.next;
      if (inflated.data.length !== declaredSize) throw new Error('pack object size mismatch');
      rawByOffset.set(entryOffset, { type, data: inflated.data, entryOffset });
    }
  }

  const trailer = buffer.subarray(offset, offset + 20);
  const digest = createHash('sha1').update(buffer.subarray(start, offset)).digest();
  const checksumOk = trailer.length === 20 && trailer.equals(digest);
  offset += 20;

  const resolved = new Map<string, GitObj>();
  const resolvedByOffset = new Map<number, GitObj>();
  for (const [entryOffset, entry] of rawByOffset) {
    const object: GitObj = { type: entry.type, data: entry.data };
    resolvedByOffset.set(entryOffset, object);
    resolved.set(hashObject(entry.type, entry.data), object);
  }
  // Resolve deltas until none are pending; a delta's base may itself be a delta.
  let guard = pending.length + 1;
  while (pending.length > 0 && guard > 0) {
    guard -= 1;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index];
      if (entry === undefined) continue;
      let base: GitObj | undefined;
      if (entry.kind === 'ofs') base = entry.baseOffset !== undefined ? resolvedByOffset.get(entry.baseOffset) : undefined;
      else if (entry.baseOid !== undefined) base = resolved.get(entry.baseOid) ?? external?.(entry.baseOid);
      if (base === undefined) continue;
      const data = applyDelta(base.data, entry.delta);
      const object: GitObj = { type: base.type, data };
      resolvedByOffset.set(entry.entryOffset, object);
      resolved.set(hashObject(base.type, data), object);
      pending.splice(index, 1);
    }
  }
  if (pending.length > 0) throw new Error('pack has a delta whose base is missing');

  return { objects: resolved, bytesRead: offset - start, checksumOk };
}
