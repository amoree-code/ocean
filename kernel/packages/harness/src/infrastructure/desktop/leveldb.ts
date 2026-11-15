import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { unsnappy, varint } from "./snappy.js";

// A read-only LevelDB reader (T-315), just enough to read a Chromium IndexedDB folder that was
// copied aside: CURRENT → MANIFEST names the live tables and the current log, every live entry
// is read, and for each user key the highest sequence number wins (a deletion hides the key).
// Never point it at a folder an app has open: copy the folder first.

export class LevelDbFormatError extends Error {}

const BLOCK_SIZE = 32 * 1024;
const RECORD_FULL = 1;
const RECORD_FIRST = 2;
const RECORD_MIDDLE = 3;
const RECORD_LAST = 4;
const TABLE_MAGIC = 0xdb4775248b80fb57n;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// LevelDB's masked CRC32C of a log record's type byte and payload.
function maskedCrc(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

// The records of a log-format file (a .log write-ahead log or a MANIFEST). A record whose
// checksum fails, or one cut off at the end (a file copied while being written), ends the
// read: everything before it is kept.
export function* logRecords(buf: Buffer): Generator<Buffer> {
  let pos = 0;
  let pending: Buffer[] | null = null;
  while (pos + 7 <= buf.length) {
    const left = BLOCK_SIZE - (pos % BLOCK_SIZE);
    if (left < 7) {
      pos += left;
      continue;
    }
    const length = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    if (type === 0 && length === 0) {
      pos += left;
      continue;
    }
    if (pos + 7 + length > buf.length) return;
    if (
      maskedCrc(buf.subarray(pos + 6, pos + 7 + length)) !==
      buf.readUInt32LE(pos)
    )
      return;
    const data = buf.subarray(pos + 7, pos + 7 + length);
    pos += 7 + length;
    if (type === RECORD_FULL) {
      pending = null;
      yield data;
    } else if (type === RECORD_FIRST) pending = [data];
    else if (type === RECORD_MIDDLE) pending?.push(data);
    else if (type === RECORD_LAST && pending) {
      pending.push(data);
      yield Buffer.concat(pending);
      pending = null;
    }
  }
}

type Entry = { sequence: number; deleted: boolean; value: Buffer };

class Entries {
  readonly map = new Map<string, Entry & { key: Buffer }>();
  put(key: Buffer, sequence: number, deleted: boolean, value: Buffer): void {
    const id = key.toString("latin1");
    const current = this.map.get(id);
    if (!current || current.sequence < sequence)
      this.map.set(id, { key, sequence, deleted, value });
  }
}

function lengthPrefixed(buf: Buffer, start: number): [Buffer, number] {
  const [length, pos] = varint(buf, start);
  if (pos + length > buf.length)
    throw new LevelDbFormatError("truncated field");
  return [buf.subarray(pos, pos + length), pos + length];
}

// A write batch: sequence (8), count (4), then put (1, key, value) or delete (0, key) entries.
function readBatch(record: Buffer, entries: Entries): void {
  if (record.length < 12) return;
  const sequence = Number(record.readBigUInt64LE(0));
  const count = record.readUInt32LE(8);
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const tag = record[pos++];
    let key: Buffer;
    [key, pos] = lengthPrefixed(record, pos);
    if (tag === 1) {
      let value: Buffer;
      [value, pos] = lengthPrefixed(record, pos);
      entries.put(Buffer.from(key), sequence + i, false, Buffer.from(value));
    } else if (tag === 0)
      entries.put(Buffer.from(key), sequence + i, true, Buffer.alloc(0));
    else throw new LevelDbFormatError(`unknown batch tag ${tag}`);
  }
}

function tableBlock(file: Buffer, handle: Buffer): Buffer {
  const [offset, next] = varint(handle, 0);
  const [size] = varint(handle, next);
  if (offset + size + 5 > file.length)
    throw new LevelDbFormatError("block out of range");
  const raw = file.subarray(offset, offset + size);
  const compression = file[offset + size];
  if (compression === 0) return raw;
  if (compression === 1) return unsnappy(raw);
  throw new LevelDbFormatError(`unsupported block compression ${compression}`);
}

function* blockEntries(block: Buffer): Generator<[Buffer, Buffer]> {
  if (block.length < 4) throw new LevelDbFormatError("short block");
  const restarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - 4 * restarts;
  if (end < 0) throw new LevelDbFormatError("bad restart count");
  let pos = 0;
  let key = Buffer.alloc(0);
  while (pos < end) {
    let shared: number;
    let unshared: number;
    let valueLength: number;
    [shared, pos] = varint(block, pos);
    [unshared, pos] = varint(block, pos);
    [valueLength, pos] = varint(block, pos);
    if (shared > key.length || pos + unshared + valueLength > end)
      throw new LevelDbFormatError("bad block entry");
    key = Buffer.concat([
      key.subarray(0, shared),
      block.subarray(pos, pos + unshared),
    ]);
    pos += unshared;
    yield [key, block.subarray(pos, pos + valueLength)];
    pos += valueLength;
  }
}

// An SSTable: the footer's index block lists the data blocks; each internal key is the user key
// followed by 8 bytes of (sequence << 8 | type), type 1 a value and 0 a deletion.
function readTable(file: Buffer, entries: Entries): void {
  if (file.length < 48) throw new LevelDbFormatError("short table");
  const footer = file.subarray(file.length - 48);
  if (footer.readBigUInt64LE(40) !== TABLE_MAGIC)
    throw new LevelDbFormatError("bad table magic");
  let pos = 0;
  [, pos] = varint(footer, pos);
  [, pos] = varint(footer, pos);
  const index = tableBlock(file, footer.subarray(pos));
  for (const [, handle] of blockEntries(index)) {
    for (const [internal, value] of blockEntries(tableBlock(file, handle))) {
      if (internal.length < 8) continue;
      const tail = internal.readBigUInt64LE(internal.length - 8);
      entries.put(
        Buffer.from(internal.subarray(0, internal.length - 8)),
        Number(tail >> 8n),
        (tail & 0xffn) === 0n,
        Buffer.from(value),
      );
    }
  }
}

// The live tables and the oldest log still needed, from the version edits in the MANIFEST.
function readManifest(buf: Buffer): { tables: Set<number>; logNumber: number } {
  const tables = new Set<number>();
  let logNumber = 0;
  let prevLogNumber = 0;
  for (const record of logRecords(buf)) {
    let pos = 0;
    const number = () => {
      let value: number;
      [value, pos] = varint(record, pos);
      return value;
    };
    const skipString = () => {
      [, pos] = lengthPrefixed(record, pos);
    };
    while (pos < record.length) {
      const tag = number();
      if (tag === 1) skipString();
      else if (tag === 2) logNumber = number();
      else if (tag === 9) prevLogNumber = number();
      else if (tag === 3 || tag === 4) number();
      else if (tag === 5) {
        number();
        skipString();
      } else if (tag === 6) {
        number();
        tables.delete(number());
      } else if (tag === 7) {
        number();
        const file = number();
        number();
        skipString();
        skipString();
        tables.add(file);
      } else throw new LevelDbFormatError(`unknown manifest tag ${tag}`);
    }
  }
  return {
    tables,
    logNumber:
      prevLogNumber > 0 ? Math.min(prevLogNumber, logNumber) : logNumber,
  };
}

const fileName = (number: number, ext: string) =>
  `${String(number).padStart(6, "0")}.${ext}`;

// Every live key of the database in `dir`, with its newest value.
export async function readLevelDb(dir: string): Promise<Map<string, Buffer>> {
  const current = (await readFile(path.join(dir, "CURRENT"), "utf8")).trim();
  if (!/^MANIFEST-\d+$/.test(current))
    throw new LevelDbFormatError("CURRENT does not name a MANIFEST");
  const { tables, logNumber } = readManifest(
    await readFile(path.join(dir, current)),
  );
  const entries = new Entries();
  for (const table of [...tables].sort((a, b) => a - b)) {
    const name = fileName(table, "ldb");
    const file = await readFile(path.join(dir, name)).catch(() =>
      readFile(path.join(dir, fileName(table, "sst"))),
    );
    readTable(file, entries);
  }
  const logs = (await readdir(dir))
    .filter(
      (name) =>
        /^\d+\.log$/.test(name) && Number.parseInt(name, 10) >= logNumber,
    )
    .sort();
  for (const log of logs)
    for (const record of logRecords(await readFile(path.join(dir, log))))
      readBatch(record, entries);
  const live = new Map<string, Buffer>();
  for (const [id, entry] of entries.map)
    if (!entry.deleted) live.set(id, entry.value);
  return live;
}
