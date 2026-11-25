// The staging area of the Yazio import (yazio_stage.py): what a person uploaded (or the direct sign-in fetched) waits here, in memory,
// between "preview" and "confirm". Nothing is written to disk.
//
// - One staging area per person, replaced by a new upload series, dropped after confirm, on "discard", and after 20 minutes without use.
//   The area has a token that changes whenever its contents change; the confirmation names the token it was shown.
// - Limits (bytes of JSON after unpacking): 24 MB per file, 32 MB per person, 96 MB for the whole server. Packed data must not be
//   absurdly dense: more than 100 times the packed size (once the result passes 1 MB) is refused while unpacking.
// - Structure limits, checked on the raw bytes BEFORE anything is parsed: at most 200,000 `{`/`[` and 2,000,000 `,`/`:` over all files
//   of a person.
// - One heavy job at a time on the whole server (unpacking, checking, preview, import): another request gets 429 at once.
// - Uploads may be plain JSON, gzip-packed JSON or a ZIP of the exporter's folder. A ZIP is read in memory only (paths cannot escape);
//   entries with an absolute, parent or odd path make the whole ZIP refused; only the expected file names are taken; an entry is read
//   with a hard bound, whatever size it declares; encrypted entries are refused.
//
// Unpacking uses the platform's DecompressionStream, fed in slices of 4 KB so that the packed bytes "used" so far are known to within
// two slices (Python knows them to the byte): the ratio check can only be that much more lenient than Python's.
import { tokenUrlsafe } from './crypto.ts';
import { FILES } from './yazio.ts';
import { crc32 } from './zip.ts';

export const MAX_FILE = 24 * 1024 * 1024;
export const MAX_PERSON = 32 * 1024 * 1024;
export const MAX_TOTAL = 96 * 1024 * 1024;
export const MAX_RATIO = 100; // unpacked / packed
export const RATIO_FREE = 1024 * 1024; // below this size the ratio is not judged
export const MAX_CONTAINERS = 200_000;
export const MAX_TOKENS = 2_000_000;
const ZIP_CD_MAX = 256 * 1024; // bytes of the central directory (1000 entries with long names fit easily)
export const TTL = 1200; // seconds
const MAX_ZIP_ENTRIES = 1000;
const MAX_ZIP_DEPTH = 4;
const SLICE = 4096;
export const UPLOAD_NAMES: readonly string[] = [...FILES, 'export.zip'];

/** The upload or the staging area cannot take this; the text is safe to show (no content of the file in it). */
export class StageError extends Error {
  code: string;
  constructor(code: string, text: string) { super(text); this.code = code; }
  get text(): string { return this.message; }
}

/** The platform's decoder said no (damaged, cut off, bad checksum). */
class Damaged extends Error {}

/** Unpack with the size and ratio limits, stopping as soon as one is passed, long before memory fills. `packed` is what the ratio is
 * measured against (the declared size for a ZIP entry); without it, the bytes fed so far. */
async function inflate(format: 'gzip' | 'deflate-raw', data: Uint8Array, limit: number, packed?: number): Promise<Uint8Array> {
  const stream = new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let fed = 0;
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        chunks.push(value);
        size += value.length;
        if (size > limit) throw new StageError('too_large', 'a file is larger than allowed after unpacking');
        if (size > RATIO_FREE && size > MAX_RATIO * Math.max(packed ?? fed, 1)) throw new StageError('too_large', 'the data is packed implausibly densely');
      }
    } catch (e) {
      writer.abort(e).catch(() => undefined); // frees a write that waits
      reader.cancel().catch(() => undefined);
      throw e;
    }
  })();
  pump.catch(() => undefined); // judged below
  try {
    for (let at = 0; at < data.length; at += SLICE) {
      const part = data.subarray(at, at + SLICE);
      fed += part.length;
      await writer.write(part as Uint8Array<ArrayBuffer>);
    }
    await writer.close();
  } catch {
    // the decoder refused (damaged data) or the pump stopped it: the pump's verdict follows
  }
  try { await pump; } catch (e) {
    if (e instanceof StageError) throw e;
    throw new Damaged();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

async function gunzip(data: Uint8Array, limit: number): Promise<Uint8Array> {
  let out: Uint8Array;
  try { out = await inflate('gzip', data, limit); } catch (e) {
    if (e instanceof Damaged) throw new StageError('bad_gzip', 'the gzip data is damaged or cut off');
    throw e;
  }
  // the platform accepts several members in a row; the file must be ONE stream (the last four bytes say how long it unpacks to)
  const tail = new DataView(data.buffer, data.byteOffset + data.length - 4, 4).getUint32(0, true);
  if (tail !== out.length % 2 ** 32) throw new StageError('bad_gzip', 'unexpected data after the gzip stream');
  return out;
}

/** (containers, tokens): a cheap upper bound of what parsing would build, from counting characters. A `{` or `,` inside a string
 * counts too, which only errs on the safe side. */
export function structure(data: Uint8Array): [number, number] {
  let containers = 0, tokens = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    if (b === 0x7b || b === 0x5b) containers++;
    else if (b === 0x2c || b === 0x3a) tokens++;
  }
  return [containers, tokens];
}

function checkStructure(files: Record<string, Uint8Array>): void {
  let containers = 0, tokens = 0;
  for (const data of Object.values(files)) {
    const [c, t] = structure(data);
    containers += c;
    tokens += t;
  }
  if (containers > MAX_CONTAINERS || tokens > MAX_TOKENS) throw new StageError('too_large', 'the files hold more entries than an export can have');
}

/** The file is JSON with an object at the top (what the importer reads). Nothing of the content goes into the error. */
function checkJson(name: string, data: Uint8Array): void {
  let value: unknown;
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new StageError('bad_json', `${name}: not text in UTF-8`); }
  try { value = JSON.parse(decoded); } catch (e) {
    throw new StageError('bad_json', e instanceof RangeError ? `${name}: nested too deeply` : `${name}: not valid JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new StageError('bad_json', `${name}: expected a JSON object at the top level`);
}

const bytesAt = (a: Uint8Array, sig: number[], from = 0, to = a.length): number => {
  for (let i = to - sig.length; i >= from; i--) if (sig.every((b, k) => a[i + k] === b)) return i;
  return -1;
};

/** Look at the end of the ZIP BEFORE reading it: every entry of the central directory would become an object, so a directory with
 * hundreds of thousands of entries would eat memory before any count could stop it. Returns the position of the end record. */
function checkZipDirectory(body: Uint8Array): number {
  const from = Math.max(0, body.length - (65535 + 22));
  const at = bytesAt(body, [0x50, 0x4b, 0x05, 0x06], from);
  if (at < 0 || body.length - at < 22) throw new StageError('bad_zip', 'the ZIP cannot be read');
  if (bytesAt(body, [0x50, 0x4b, 0x06, 0x07], from, at) >= 0) throw new StageError('bad_zip', 'ZIP64 archives are not accepted');
  const end = new DataView(body.buffer, body.byteOffset + at, 22);
  const entries = end.getUint16(10, true), directorySize = end.getUint32(12, true);
  if (entries === 0xffff || directorySize === 0xffffffff) throw new StageError('bad_zip', 'ZIP64 archives are not accepted');
  if (entries > MAX_ZIP_ENTRIES || directorySize > ZIP_CD_MAX) throw new StageError('bad_zip', 'the ZIP has too many entries');
  return at;
}

interface ZipEntry { raw: Uint8Array; name: string; flags: number; method: number; crc: number; packed: number; size: number; offset: number }

/** The central directory, entry by entry (what zipfile does): the names are decoded as UTF-8 when the entry says so, else byte by byte
 * (only ASCII can matter: the checks below look for `/`, `\`, `:` and `..`). A name ends at the first NUL, as in zipfile. */
function zipEntries(body: Uint8Array, endAt: number): ZipEntry[] {
  const end = new DataView(body.buffer, body.byteOffset + endAt, 22);
  const size = end.getUint32(12, true), offset = end.getUint32(16, true);
  const concat = endAt - size - offset;
  const start = offset + concat;
  if (start < 0) throw new StageError('bad_zip', 'the ZIP cannot be read');
  const view = new DataView(body.buffer, body.byteOffset, body.length);
  const out: ZipEntry[] = [];
  let at = start;
  while (at < start + size) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new StageError('bad_zip', 'the ZIP cannot be read');
    const nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true), commentLength = view.getUint16(at + 32, true);
    const raw = body.subarray(at + 46, at + 46 + nameLength);
    if (raw.length !== nameLength) throw new StageError('bad_zip', 'the ZIP cannot be read');
    const flags = view.getUint16(at + 8, true);
    let name: string;
    try {
      name = flags & 0x800 ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : String.fromCharCode(...raw);
    } catch { throw new StageError('bad_zip', 'the ZIP cannot be read'); }
    const nul = name.indexOf('\0');
    out.push({
      raw, name: nul >= 0 ? name.slice(0, nul) : name, flags, method: view.getUint16(at + 10, true), crc: view.getUint32(at + 16, true),
      packed: view.getUint32(at + 20, true), size: view.getUint32(at + 24, true), offset: view.getUint32(at + 42, true) + concat,
    });
    if (out.length > MAX_ZIP_ENTRIES) throw new StageError('bad_zip', 'the ZIP has too many entries');
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** One entry's bytes: stored or deflated, read with the size and ratio limits whatever the entry declares, and checked against its
 * declared size and checksum. */
async function readMember(body: Uint8Array, info: ZipEntry, limit: number): Promise<Uint8Array> {
  const view = new DataView(body.buffer, body.byteOffset, body.length);
  if (info.offset < 0 || info.offset + 30 > body.length || view.getUint32(info.offset, true) !== 0x04034b50) throw new StageError('bad_zip', 'the ZIP cannot be read');
  const nameLength = view.getUint16(info.offset + 26, true), extraLength = view.getUint16(info.offset + 28, true);
  const local = body.subarray(info.offset + 30, info.offset + 30 + nameLength);
  if (local.length !== info.raw.length || local.some((b, i) => b !== info.raw[i])) throw new StageError('bad_zip', 'the ZIP cannot be read');
  const from = info.offset + 30 + nameLength + extraLength;
  if (from + info.packed > body.length) throw new StageError('bad_zip', 'the ZIP cannot be read');
  const packed = body.subarray(from, from + info.packed);
  let data: Uint8Array;
  if (info.method === 0) {
    if (packed.length > limit) throw new StageError('too_large', 'a file is larger than allowed after unpacking');
    data = packed;
  } else if (info.method === 8) {
    try { data = await inflate('deflate-raw', packed, limit, info.packed); } catch (e) {
      if (e instanceof Damaged) throw new StageError('bad_zip', 'the ZIP cannot be read');
      throw e;
    }
  } else throw new StageError('bad_zip', 'the ZIP cannot be read'); // another way of packing
  if (data.length !== info.size || crc32(data) !== info.crc) throw new StageError('bad_zip', 'the ZIP cannot be read');
  return data;
}

/** The entries named `names` (by their last path part; everything else is never read), each at most `file` bytes unpacked, together
 * at most `total`. The data import (dataImport.ts) uses it for the one JSON file of a Mahlwerk export. */
export async function unzip(body: Uint8Array, names: readonly string[] = FILES, file = MAX_FILE, total = MAX_PERSON): Promise<Record<string, Uint8Array>> {
  const endAt = checkZipDirectory(body);
  const found: Record<string, Uint8Array> = Object.create(null);
  let sum = 0;
  try {
    for (const info of zipEntries(body, endAt)) {
      const path = info.name;
      const parts = path.split('/');
      if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || parts.includes('..') || parts[0]!.includes(':') || parts.length > MAX_ZIP_DEPTH) {
        throw new StageError('bad_zip', 'the ZIP contains an unsafe path');
      }
      if (path.endsWith('/')) continue;
      const base = parts[parts.length - 1]!;
      if (!names.includes(base)) continue; // anything else is ignored, never read
      if (info.flags & 0x1) throw new StageError('bad_zip', 'the ZIP is encrypted');
      if (base in found) throw new StageError('bad_zip', `the ZIP has ${base} twice`);
      if (info.size > file) throw new StageError('too_large', 'a file is larger than allowed after unpacking');
      const data = await readMember(body, info, file);
      sum += data.length;
      if (sum > total) throw new StageError('too_large', 'the files are larger than allowed after unpacking');
      found[base] = data;
    }
  } catch (e) {
    if (e instanceof StageError) throw e;
    throw new StageError('bad_zip', 'the ZIP cannot be read'); // an offset outside the data and the like
  }
  return { ...found };
}

/** The files in one upload: `name` is a file of the export or `export.zip`. Throws StageError. */
export async function decodeUpload(name: string, upload: Uint8Array): Promise<Record<string, Uint8Array>> {
  let body = upload;
  if (!UPLOAD_NAMES.includes(name)) throw new StageError('bad_name', 'unexpected file name (days.json, products.json, weight.json or a ZIP)');
  if (!body.length) throw new StageError('empty', 'the file is empty');
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) body = await gunzip(body, name === 'export.zip' ? MAX_PERSON : MAX_FILE); // a ZIP is as big as its three files
  let files: Record<string, Uint8Array>;
  if (name === 'export.zip' || (body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b && body[2] === 3 && body[3] === 4)) {
    if (name !== 'export.zip') throw new StageError('bad_name', 'a ZIP must be sent as export.zip');
    files = await unzip(body);
    if (!Object.keys(files).length) throw new StageError('bad_zip', `the ZIP holds none of ${FILES.join(', ')}`);
  } else {
    if (body.length > MAX_FILE) throw new StageError('too_large', 'a file is larger than allowed');
    files = { [name]: body };
  }
  checkStructure(files); // before any parsing
  for (const [fileName, data] of Object.entries(files)) checkJson(fileName, data);
  return files;
}

export interface Stage { files: Record<string, Uint8Array>; token: string; source: string; expires: number }

export const stageSize = (s: Stage): number => Object.values(s.files).reduce((n, v) => n + v.length, 0);

export const stageView = (s: Stage) => ({ token: s.token, source: s.source, files: Object.fromEntries(Object.keys(s.files).sort().map((k) => [k, s.files[k]!.length])) });

export class Staging {
  clock: () => number;
  private stages = new Map<number, Stage>();
  private busy = new Set<number>();
  private heavy = false;

  constructor(clock: () => number) { this.clock = clock; }

  /** Take the one place for heavy work (unpacking, checking, preview, import); false at once when it is taken. */
  tryHeavy(): boolean {
    if (this.heavy) return false;
    this.heavy = true;
    return true;
  }

  releaseHeavy(): void { this.heavy = false; }

  /** How many areas are held (without expiring any). */
  held(): number { return this.stages.size; }

  /** Drop the areas whose time is up (cheap: called before every request, see dispatch.ts). */
  sweep(): void { this.expire(); }

  private expire(): void {
    const now = this.clock();
    for (const [uid, s] of this.stages) if (s.expires < now && !this.busy.has(uid)) this.stages.delete(uid);
  }

  get(userId: number): Stage | undefined {
    this.expire();
    return this.stages.get(userId);
  }

  /** Put files into the person's area (a file of the same name replaces the old one; `replace` empties the area first). The token changes. */
  add(userId: number, files: Record<string, Uint8Array>, source = 'upload', replace = false): Stage {
    this.expire();
    const old = this.stages.get(userId);
    const keep = replace || !old || old.source !== source ? {} : { ...old.files };
    const stage: Stage = { files: { ...keep, ...files }, token: tokenUrlsafe(12), source, expires: this.clock() + TTL };
    let others = 0;
    for (const [u, s] of this.stages) if (u !== userId) others += stageSize(s);
    if (stageSize(stage) > MAX_PERSON) throw new StageError('too_large', 'the files together are larger than allowed');
    checkStructure(stage.files);
    if (others + stageSize(stage) > MAX_TOTAL) throw new StageError('busy', 'the server holds too many uploads at the moment; try again in a few minutes');
    this.stages.set(userId, stage);
    return stage;
  }

  /** Drop the person's area; with `token` only if it is still the one with that token (an upload that arrived while an import ran stays). */
  clear(userId: number, token?: string): void {
    const s = this.stages.get(userId);
    if (s && (token === undefined || s.token === token)) this.stages.delete(userId);
  }

  /** Mark a preview or import of this person as running (one at a time); false when one already runs. */
  begin(userId: number): boolean {
    if (this.busy.has(userId)) return false;
    this.busy.add(userId);
    return true;
  }

  end(userId: number): void {
    this.busy.delete(userId);
    const s = this.stages.get(userId);
    if (s) s.expires = this.clock() + TTL;
  }
}
