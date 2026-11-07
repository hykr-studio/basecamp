// A small zip writer and reader (PKWARE APPNOTE 6.3: local headers, a central directory, deflate
// or stored entries, UTF-8 names), on node:zlib. Enough for an export archive: no ZIP64, so at
// most 65,535 entries and 4 GiB, both checked.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** General purpose flag bit 11: the name is UTF-8. */
const UTF8 = 0x0800;
const DEFLATE = 8;
const STORED = 0;
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

interface Entry {
  name: Buffer;
  method: number;
  crc: number;
  size: number;
  data: Buffer;
  offset: number;
}

/** MS-DOS date and time, as zip keeps them (local time of the writer; we use UTC). */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * Builds an archive one file at a time: each file is compressed when it is added, so only the
 * compressed bytes are held. `size` is what `finish()` will return, give or take its directory.
 */
export class ZipWriter {
  private readonly entries: Entry[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private readonly stamp: { time: number; date: number };

  constructor(at: Date = new Date()) {
    this.stamp = dosTime(at);
  }

  /** Bytes so far: local headers and data, without the central directory. */
  get size(): number {
    return this.offset;
  }

  add(name: string, data: Buffer | string): void {
    if (!name || name.startsWith('/') || name.split('/').includes('..'))
      throw new Error(`Bad entry name "${name}"`);
    if (this.names.has(name)) throw new Error(`The archive already has "${name}"`);
    if (this.entries.length >= MAX_ENTRIES) throw new Error('Too many entries for a zip archive');
    const raw = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (raw.length > MAX_SIZE) throw new Error(`"${name}" is too large for a zip archive`);
    const deflated = deflateRawSync(raw, { level: 6 });
    // Data that does not shrink is kept as it is.
    const [method, body] = deflated.length < raw.length ? [DEFLATE, deflated] : [STORED, raw];
    const entry: Entry = {
      name: Buffer.from(name, 'utf8'),
      method,
      crc: crc32(raw) >>> 0,
      size: raw.length,
      data: body,
      offset: this.offset,
    };
    const next = this.offset + 30 + entry.name.length + body.length;
    if (next > MAX_SIZE) throw new Error('The archive is too large for a zip archive');
    this.entries.push(entry);
    this.names.add(name);
    this.offset = next;
  }

  /** The whole archive. */
  finish(): Buffer {
    const parts: Buffer[] = [];
    for (const e of this.entries) {
      const head = Buffer.alloc(30);
      head.writeUInt32LE(LOCAL, 0);
      head.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
      head.writeUInt16LE(UTF8, 6);
      head.writeUInt16LE(e.method, 8);
      head.writeUInt16LE(this.stamp.time, 10);
      head.writeUInt16LE(this.stamp.date, 12);
      head.writeUInt32LE(e.crc, 14);
      head.writeUInt32LE(e.data.length, 18);
      head.writeUInt32LE(e.size, 22);
      head.writeUInt16LE(e.name.length, 26);
      head.writeUInt16LE(0, 28);
      parts.push(head, e.name, e.data);
    }
    const start = this.offset;
    let dirSize = 0;
    for (const e of this.entries) {
      const dir = Buffer.alloc(46);
      dir.writeUInt32LE(CENTRAL, 0);
      dir.writeUInt16LE(20, 4); // made by: 2.0, MS-DOS attributes
      dir.writeUInt16LE(20, 6);
      dir.writeUInt16LE(UTF8, 8);
      dir.writeUInt16LE(e.method, 10);
      dir.writeUInt16LE(this.stamp.time, 12);
      dir.writeUInt16LE(this.stamp.date, 14);
      dir.writeUInt32LE(e.crc, 16);
      dir.writeUInt32LE(e.data.length, 20);
      dir.writeUInt32LE(e.size, 24);
      dir.writeUInt16LE(e.name.length, 28);
      // extra, comment, disk, internal and external attributes: none
      dir.writeUInt32LE(e.offset, 42);
      parts.push(dir, e.name);
      dirSize += dir.length + e.name.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(dirSize, 12);
    end.writeUInt32LE(start, 16);
    parts.push(end);
    return Buffer.concat(parts);
  }
}

/** An archive of these files, in this order. */
export function writeZip(
  files: readonly { name: string; data: Buffer | string }[],
  at?: Date,
): Buffer {
  const zip = new ZipWriter(at);
  for (const f of files) zip.add(f.name, f.data);
  return zip.finish();
}

/**
 * The files of an archive, by name, in the order of its directory. Stored and deflated entries
 * only; each one's CRC-32 and size are checked. Throws on anything else.
 */
export function readZip(bytes: Buffer): Map<string, Buffer> {
  const from = Math.max(0, bytes.length - 22 - 0xffff);
  let end = -1;
  for (let i = bytes.length - 22; i >= from; i--)
    if (bytes.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('Not a zip archive');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (bytes.readUInt32LE(at) !== CENTRAL) throw new Error('A broken zip directory');
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const packed = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extra + comment;
    if (bytes.readUInt32LE(local) !== LOCAL) throw new Error(`A broken entry "${name}"`);
    const dataAt = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const body = bytes.subarray(dataAt, dataAt + packed);
    const data =
      method === STORED
        ? Buffer.from(body)
        : method === DEFLATE
          ? inflateRawSync(body)
          : (() => {
              throw new Error(`"${name}" uses a compression this reader does not know`);
            })();
    if (data.length !== size || crc32(data) >>> 0 !== crc)
      throw new Error(`"${name}" does not match its checksum`);
    out.set(name, data);
  }
  return out;
}
