// Raw Snappy block decompression (T-315), the format LevelDB uses for table blocks and Chromium
// IndexedDB uses for compressed values. Read-only and dependency-free; malformed input throws.

export function varint(buf: Uint8Array, start: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = start;
  for (;;) {
    if (pos >= buf.length || shift > 63) throw new Error("bad varint");
    const byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [result, pos];
    shift += 7;
  }
}

export function unsnappy(src: Buffer): Buffer {
  let [length, pos] = varint(src, 0);
  if (length > 512 * 1024 * 1024) throw new Error("snappy: length too large");
  const out = Buffer.alloc(length);
  let op = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const type = tag & 3;
    if (type === 0) {
      let len = tag >> 2;
      if (len >= 60) {
        const bytes = len - 59;
        if (pos + bytes > src.length) throw new Error("snappy: truncated");
        len = src.readUIntLE(pos, bytes);
        pos += bytes;
      }
      len += 1;
      if (pos + len > src.length || op + len > length)
        throw new Error("snappy: literal out of range");
      src.copy(out, op, pos, pos + len);
      pos += len;
      op += len;
      continue;
    }
    let len: number;
    let offset: number;
    if (type === 1) {
      if (pos >= src.length) throw new Error("snappy: truncated");
      len = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | src[pos++];
    } else if (type === 2) {
      if (pos + 2 > src.length) throw new Error("snappy: truncated");
      len = (tag >> 2) + 1;
      offset = src.readUInt16LE(pos);
      pos += 2;
    } else {
      if (pos + 4 > src.length) throw new Error("snappy: truncated");
      len = (tag >> 2) + 1;
      offset = src.readUInt32LE(pos);
      pos += 4;
    }
    if (offset === 0 || offset > op || op + len > length)
      throw new Error("snappy: copy out of range");
    for (let i = 0; i < len; i++, op++) out[op] = out[op - offset];
  }
  if (op !== length) throw new Error("snappy: length mismatch");
  return out;
}
