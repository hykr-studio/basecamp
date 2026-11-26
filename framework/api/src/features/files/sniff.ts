/**
 * What a file's first bytes say it is. Confirm reads the start of every upload: a file that
 * claims to be an image or a PDF must start like one, and an image's size in pixels is kept.
 */

/** How many bytes to read: enough for every header below, JPEG's markers included. */
export const SNIFF_BYTES = 64 * 1024;

export type Sniffed = {
  /** The type its bytes show, when they show one this module knows. */
  mime?: string;
  width?: number;
  height?: number;
};

const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString('latin1');

function jpegSize(b: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = b.readUInt16BE(i + 2);
    // Start of frame: every SOFn but DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return undefined;
}

function webpSize(b: Buffer): { width: number; height: number } | undefined {
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30)
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30)
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return undefined;
}

const HEIF_BRANDS: Record<string, string> = {
  heic: 'image/heic',
  heix: 'image/heic',
  hevc: 'image/heic',
  hevx: 'image/heic',
  heim: 'image/heic',
  heis: 'image/heic',
  mif1: 'image/heif',
  msf1: 'image/heif',
  avif: 'image/avif',
  avis: 'image/avif',
};

/** The type and, for raster images, the size in pixels that these first bytes show. */
export function sniff(b: Buffer): Sniffed {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { mime: 'image/jpeg', ...jpegSize(b) };
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a'))
    return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP')
    return { mime: 'image/webp', ...webpSize(b) };
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = HEIF_BRANDS[ascii(b, 8, 12)];
    if (brand) return { mime: brand };
  }
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return { mime: 'application/pdf' };
  return {};
}

/** Types whose bytes must show them, with the types those bytes may show instead. */
const MUST_MATCH: Record<string, readonly string[]> = {
  'image/jpeg': ['image/jpeg'],
  'image/jpg': ['image/jpeg'],
  'image/pjpeg': ['image/jpeg'],
  'image/png': ['image/png'],
  'image/gif': ['image/gif'],
  'image/webp': ['image/webp'],
  'image/heic': ['image/heic', 'image/heif'],
  'image/heif': ['image/heic', 'image/heif'],
  'image/avif': ['image/avif'],
  'application/pdf': ['application/pdf'],
};

/**
 * Do these bytes fit the declared type? A declared image or PDF must start like one; other
 * types are not checked (they are served as attachments, never inline, unless safe).
 */
export function bytesFit(declared: string, found: Sniffed): boolean {
  const want = MUST_MATCH[declared];
  return !want || (found.mime !== undefined && want.includes(found.mime));
}
