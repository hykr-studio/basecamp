// A file as a vision model is shown it: an image (scaled down to the longest side allowed), a
// PDF as it is (a model that takes PDFs), or a PDF's chosen pages drawn as images with their text
// layer alongside. The PDF and image libraries are loaded on first use, and at most two files
// are prepared at once in a process (drawing pages is CPU work).
import type { VisionPart } from '@hykr/agents';
import { baseMime } from '@hykr/contracts';
import { HttpException, UnprocessableEntityException } from '@nestjs/common';
import { sniff } from '../sniff.js';

/** The limits one read works within (FILES_READ_*). */
export interface ReadLimits {
  maxBytes: number;
  maxPages: number;
  maxSide: number;
  dpi: number;
}

/** Types a model may read: raster images it takes, and PDFs. */
const IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PDF = 'application/pdf';

const unprocessable = (error: string, message: string) =>
  new UnprocessableEntityException({ error, message });

/** Why this file cannot be read, before its bytes are fetched (its declared type and size). */
export function readableProblem(
  row: { mime: string; size: number },
  limits: ReadLimits,
): HttpException | undefined {
  const mime = baseMime(row.mime);
  if (mime === 'image/heic' || mime === 'image/heif')
    return unprocessable(
      'unsupported_type',
      'HEIC photos cannot be read yet: send the photo as JPEG (most phones can share it so)',
    );
  if (!IMAGES.has(mime) && mime !== PDF)
    return unprocessable(
      'unsupported_type',
      'Only photos and scans (PNG, JPEG, WebP) and PDFs can be read',
    );
  if (row.size > limits.maxBytes)
    return unprocessable(
      'too_large',
      `Files over ${Math.round(limits.maxBytes / (1024 * 1024))} MB cannot be read`,
    );
  return undefined;
}

/* ── One at a time (two) ─────────────────────────────────────────────────── */

const MAX_AT_ONCE = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/* ── Libraries, loaded when first needed ────────────────────────────────── */

type Canvas = typeof import('@napi-rs/canvas');
let canvasLib: Promise<Canvas> | undefined;
const canvas = () => {
  canvasLib ??= import('@napi-rs/canvas');
  return canvasLib;
};

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfLib: Promise<Pdfjs> | undefined;
const pdfjs = () => {
  pdfLib ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfLib;
};

/* ── Images ─────────────────────────────────────────────────────────────── */

/** The image within the longest side: as it is when it fits, else drawn smaller as JPEG. */
export async function fitImage(
  bytes: Buffer,
  mime: string,
  maxSide: number,
): Promise<{ data: Uint8Array; mediaType: string }> {
  const found = sniff(bytes.subarray(0, 64 * 1024));
  if (!found.mime || !IMAGES.has(found.mime))
    throw unprocessable('unsupported_type', `Not a ${mime} image`);
  const { width, height } = found;
  if (width && height && Math.max(width, height) <= maxSide)
    return { data: new Uint8Array(bytes), mediaType: found.mime };
  const { createCanvas, loadImage } = await canvas();
  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImage(bytes);
  } catch {
    throw unprocessable('damaged', 'The image could not be opened');
  }
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  if (scale === 1) return { data: new Uint8Array(bytes), mediaType: found.mime };
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(image, 0, 0, w, h);
  return { data: new Uint8Array(c.toBuffer('image/jpeg', 85)), mediaType: 'image/jpeg' };
}

/* ── PDFs ───────────────────────────────────────────────────────────────── */

/** The pages to read: those asked for (1-based, checked), else all of them within the limit. */
export function choosePages(count: number, asked: readonly number[] | undefined, maxPages: number) {
  if (asked?.length) {
    const pages = [...new Set(asked)];
    const bad = pages.filter((n) => !Number.isInteger(n) || n < 1 || n > count);
    if (bad.length)
      throw unprocessable(
        'bad_pages',
        `The file has ${count} page${count === 1 ? '' : 's'}: there is no page ${bad.join(', ')}`,
      );
    if (pages.length > maxPages)
      throw unprocessable('too_many_pages', `At most ${maxPages} pages can be read at once`);
    return pages;
  }
  if (count > maxPages)
    throw unprocessable(
      'too_many_pages',
      `The file has ${count} pages; at most ${maxPages} can be read at once. Say which pages to read.`,
    );
  return Array.from({ length: count }, (_, i) => i + 1);
}

/** What a read sends: the parts, and how many images or pages they hold (the file_pages meter). */
export interface Prepared {
  parts: VisionPart[];
  /** Images and pages sent. */
  pages: number;
}

async function preparePdf(
  bytes: Buffer,
  o: { pages?: readonly number[]; takesPdf: boolean; limits: ReadLimits },
): Promise<Prepared> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    verbosity: 0,
  });
  try {
    let pdf: Awaited<typeof task.promise>;
    try {
      pdf = await task.promise;
    } catch {
      throw unprocessable('damaged', 'The PDF could not be opened (damaged, or locked)');
    }
    const pages = choosePages(pdf.numPages, o.pages, o.limits.maxPages);
    // Sent as it is: the model reads every page itself.
    if (o.takesPdf && !o.pages?.length)
      return {
        parts: [{ type: 'file', data: new Uint8Array(bytes), mediaType: 'application/pdf' }],
        pages: pages.length,
      };
    const { createCanvas } = await canvas();
    const parts: VisionPart[] = [];
    for (const n of pages) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        o.limits.dpi / 72,
        o.limits.maxSide / Math.max(base.width, base.height),
      );
      const viewport = page.getViewport({ scale });
      const c = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({
        canvas: c as never,
        canvasContext: ctx as never,
        viewport,
      }).promise;
      const text = (await page.getTextContent()).items
        .map((i) => ('str' in i ? i.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      parts.push({ type: 'text', text: `Page ${n}${text ? `, its text layer: ${text}` : ''}` });
      parts.push({
        type: 'image',
        image: new Uint8Array(c.toBuffer('image/jpeg', 85)),
        mediaType: 'image/jpeg',
      });
      page.cleanup();
    }
    return { parts, pages: pages.length };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/**
 * The file as model parts. Its bytes must show its type (a file claiming to be a PNG that is
 * not is refused); pages must be within the file and the limit.
 */
export function prepare(
  bytes: Buffer,
  mime: string,
  o: { pages?: readonly number[]; takesPdf: boolean; limits: ReadLimits },
): Promise<Prepared> {
  return slot(async () => {
    if (bytes.length > o.limits.maxBytes)
      throw unprocessable('too_large', 'The file is too large to read');
    const declared = baseMime(mime);
    if (declared === PDF) {
      if (sniff(bytes.subarray(0, 16)).mime !== PDF)
        throw unprocessable('unsupported_type', 'Not a PDF file');
      return preparePdf(bytes, o);
    }
    if (o.pages?.length) throw unprocessable('bad_pages', 'Pages can only be chosen in a PDF');
    const image = await fitImage(bytes, declared, o.limits.maxSide);
    return { parts: [{ type: 'image', image: image.data, mediaType: image.mediaType }], pages: 1 };
  });
}
