/**
 * MikroTik RouterOS API wire protocol (TCP 8728 / TLS 8729).
 * A sentence is a sequence of length-prefixed words terminated by an empty word.
 * Length prefix: 1–5 bytes (see encodeLength). Replies start with !re, !done, !trap or !fatal.
 */
export function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([((len >> 8) & 0xff) | 0x80, len & 0xff]);
  if (len < 0x200000) return Buffer.from([((len >> 16) & 0xff) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  if (len < 0x10000000) return Buffer.from([((len >> 24) & 0xff) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([0xf0, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

/** Decode a length prefix at `offset`. Returns null if more bytes are needed. */
export function decodeLength(buf: Buffer, offset: number): { length: number; bytes: number } | null {
  if (offset >= buf.length) return null;
  const b = buf[offset]!;
  if ((b & 0x80) === 0x00) return { length: b, bytes: 1 };
  if ((b & 0xc0) === 0x80) return offset + 1 < buf.length ? { length: ((b & 0x3f) << 8) | buf[offset + 1]!, bytes: 2 } : null;
  if ((b & 0xe0) === 0xc0) return offset + 2 < buf.length ? { length: ((b & 0x1f) << 16) | (buf[offset + 1]! << 8) | buf[offset + 2]!, bytes: 3 } : null;
  if ((b & 0xf0) === 0xe0) return offset + 3 < buf.length ? { length: (((b & 0x0f) << 24) | (buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!) >>> 0, bytes: 4 } : null;
  if (b === 0xf0) return offset + 4 < buf.length ? { length: buf.readUInt32BE(offset + 1), bytes: 5 } : null;
  throw new Error("Invalid RouterOS length prefix");
}

export function encodeSentence(words: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const w of words) {
    const bytes = Buffer.from(w, "utf8");
    parts.push(encodeLength(bytes.length), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Incremental parser: feed bytes, receive complete sentences. */
export class SentenceReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[][] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const sentences: string[][] = [];
    let offset = 0;
    let words: string[] = [];
    let sentenceStart = 0;
    for (;;) {
      const len = decodeLength(this.buf, offset);
      if (!len) break;
      if (offset + len.bytes + len.length > this.buf.length) break;
      if (len.length === 0) {
        sentences.push(words);
        words = [];
        offset += len.bytes;
        sentenceStart = offset;
        continue;
      }
      words.push(this.buf.subarray(offset + len.bytes, offset + len.bytes + len.length).toString("utf8"));
      offset += len.bytes + len.length;
    }
    this.buf = this.buf.subarray(sentenceStart);
    return sentences;
  }
}

/** Parse "=key=value" attribute words of a reply into an object. */
export function parseAttributes(words: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of words) {
    if (!w.startsWith("=")) continue;
    const i = w.indexOf("=", 1);
    if (i === -1) continue;
    out[w.slice(1, i)] = w.slice(i + 1);
  }
  return out;
}

/** Raised when a value cannot be sent safely (never retried). */
export class RouterOsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterOsInputError";
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Build attribute / query words with validation (no control characters that could smuggle extra words). */
export function attr(key: string, value: string | number | boolean): string {
  const v = String(value);
  if (!/^[a-z0-9.-]+$/i.test(key) || CONTROL_CHARS.test(v)) throw new RouterOsInputError("Invalid RouterOS attribute");
  return `=${key}=${v}`;
}

export function query(key: string, value: string): string {
  if (!/^[a-z0-9.-]+$/i.test(key) || CONTROL_CHARS.test(value)) throw new RouterOsInputError("Invalid RouterOS query");
  return `?${key}=${value}`;
}
