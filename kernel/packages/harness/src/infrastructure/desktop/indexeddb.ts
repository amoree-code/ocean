import { readFile } from "node:fs/promises";
import path from "node:path";
import v8 from "node:v8";
import { readLevelDb } from "./leveldb.js";
import { unsnappy, varint } from "./snappy.js";

// Chromium IndexedDB on LevelDB (T-315), read-only. Every key starts with a prefix naming the
// database, object store and index; index 1 holds a store's records, index 3 the blob list of a
// record whose value lives in a separate blob file. A value is a varint version, then either a
// Blink-serialized value or a wrapper: 0xFF 0x11 0x02 + raw Snappy of one, or 0xFF 0x11 0x01 +
// size + blob index, meaning the bytes are in that blob file. A Blink value is 0xFF + version
// (+ 0xFE and a 12-byte trailer from version 21), then V8's own serialization.

export class IndexedDbFormatError extends Error {}

const OBJECT_STORE_DATA = 1;
const BLOB_ENTRY = 3;
const OBJECT_STORE_META = 50;
const WRAPPED = 0x11;
const WRAPPED_IN_BLOB = 0x01;
const WRAPPED_SNAPPY = 0x02;

type KeyPrefix = {
  database: number;
  store: number;
  index: number;
  rest: Buffer;
};

export function keyPrefix(key: Buffer): KeyPrefix | null {
  if (key.length < 4) return null;
  const first = key[0];
  const sizes = [(first >> 5) + 1, ((first >> 2) & 7) + 1, (first & 3) + 1];
  let pos = 1;
  const ids: number[] = [];
  for (const size of sizes) {
    if (pos + size > key.length) return null;
    ids.push(key.readUIntLE(pos, size));
    pos += size;
  }
  return {
    database: ids[0],
    store: ids[1],
    index: ids[2],
    rest: key.subarray(pos),
  };
}

function utf16be(bytes: Buffer): string {
  const copy = Buffer.from(bytes);
  copy.swap16();
  return copy.toString("utf16le");
}

// V8's serializer writes a format version; this Node may know only older ones. Version 16 is
// read as 15 only after a plain read fails (Desktop's Chromium writes 16, Node 22 reads up to
// 15); the fixture test guards that this still decodes.
function v8Value(bytes: Buffer): unknown {
  if (bytes[0] !== 0xff) throw new IndexedDbFormatError("no V8 header");
  try {
    return v8.deserialize(bytes);
  } catch (error) {
    if (bytes[1] !== 16) throw error;
    const patched = Buffer.from(bytes);
    patched[1] = 15;
    return v8.deserialize(patched);
  }
}

function blinkValue(bytes: Buffer): unknown {
  if (bytes[0] !== 0xff) throw new IndexedDbFormatError("no Blink header");
  let [, pos] = varint(bytes, 1);
  if (bytes[pos] === 0xfe) pos += 13;
  return v8Value(Buffer.from(bytes.subarray(pos)));
}

// A record's blob list: per blob, is-file flag, blob number, MIME type, then size (a plain blob)
// or name and modification time (a File). Only plain blobs are read.
export function blobNumbers(value: Buffer): number[] {
  const numbers: number[] = [];
  let pos = 0;
  while (pos < value.length) {
    const isFile = value[pos++] !== 0;
    let number: number;
    let typeChars: number;
    [number, pos] = varint(value, pos);
    [typeChars, pos] = varint(value, pos);
    pos += typeChars * 2;
    if (isFile) throw new IndexedDbFormatError("file blobs are not read");
    [, pos] = varint(value, pos);
    numbers.push(number);
  }
  return numbers;
}

export function blobPath(
  blobDir: string,
  database: number,
  number: number,
): string {
  return path.join(
    blobDir,
    database.toString(16),
    (Math.floor(number / 256) % 256).toString(16).padStart(2, "0"),
    number.toString(16),
  );
}

async function wireValue(
  bytes: Buffer,
  blob: (index: number) => Promise<Buffer>,
  depth = 0,
): Promise<unknown> {
  if (bytes[0] === 0xff && bytes[1] === WRAPPED) {
    if (bytes[2] === WRAPPED_SNAPPY)
      return blinkValue(unsnappy(bytes.subarray(3)));
    if (bytes[2] === WRAPPED_IN_BLOB && depth === 0) {
      const [, next] = varint(bytes, 3);
      const [index] = varint(bytes, next);
      return wireValue(await blob(index), blob, depth + 1);
    }
    throw new IndexedDbFormatError("unknown value wrapper");
  }
  return blinkValue(bytes);
}

export type IdbRecord = { database: number; store: string; value: unknown };

// The decoded records of every object store whose name `wanted` accepts. A record that does not
// decode is counted in `skipped`, never fatal.
export async function readIndexedDb(
  leveldbDir: string,
  blobDir: string,
  wanted: (store: string) => boolean,
): Promise<{ records: IdbRecord[]; skipped: number }> {
  const entries = await readLevelDb(leveldbDir);
  const names = new Map<string, string>();
  const blobs = new Map<string, Buffer>();
  const data: { prefix: KeyPrefix; value: Buffer }[] = [];
  for (const [id, value] of entries) {
    const prefix = keyPrefix(Buffer.from(id, "latin1"));
    if (!prefix || prefix.database === 0) continue;
    const { database, store, index, rest } = prefix;
    if (store === 0 && index === 0 && rest[0] === OBJECT_STORE_META) {
      // Metadata keys this reader does not know are passed over, never fatal.
      const parsed = (() => {
        try {
          return varint(rest, 1);
        } catch {
          return null;
        }
      })();
      if (parsed && parsed[1] === rest.length - 1 && rest[parsed[1]] === 0)
        names.set(`${database}/${parsed[0]}`, utf16be(value));
    } else if (store > 0 && index === BLOB_ENTRY)
      blobs.set(`${database}/${store}/${rest.toString("latin1")}`, value);
    else if (store > 0 && index === OBJECT_STORE_DATA)
      data.push({ prefix, value });
  }
  const records: IdbRecord[] = [];
  let skipped = 0;
  for (const { prefix, value } of data) {
    const store = names.get(`${prefix.database}/${prefix.store}`);
    if (store === undefined || !wanted(store)) continue;
    try {
      const [, pos] = varint(value, 0);
      const decoded = await wireValue(
        Buffer.from(value.subarray(pos)),
        async (index) => {
          const list = blobs.get(
            `${prefix.database}/${prefix.store}/${prefix.rest.toString("latin1")}`,
          );
          const number = list ? blobNumbers(list)[index] : undefined;
          if (number === undefined)
            throw new IndexedDbFormatError("missing blob entry");
          return readFile(blobPath(blobDir, prefix.database, number));
        },
      );
      records.push({ database: prefix.database, store, value: decoded });
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}
