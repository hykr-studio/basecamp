// Images in documents (B21), without booting: the image, images and qr blocks and a header or
// footer image in the layout model, their lines, the limits' configuration, the check that a
// layout names only images its load was given, and the PDF engine drawing them (fitted, turned
// by a JPEG's EXIF orientation, a grid's rows never split, a header logo the content never runs
// under, a QR code whose squares are the encoder's matrix, captions shaped in Hindi and Telugu).
import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { imageLimits } from '../../dist/features/documents/config.js';
import { createFakeEngine, createPdfEngine } from '../../dist/features/documents/engine/index.js';
import { checkLayoutImages } from '../../dist/features/documents/images.js';
import {
  type DocumentBlock,
  DocumentLayout,
  type ImageRef,
  imageRefsOf,
  layoutLines,
} from '../../dist/features/documents/layout.js';
import { sniff } from '../../dist/features/files/sniff.js';

/* ── Images made here: a PNG of one colour, a 32 × 16 JPEG, the JPEG turned by EXIF ──────── */

function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([head, body, crc]);
}

/** A width × height RGB PNG of one colour. */
function png(width: number, height: number, rgb: [number, number, number] = [40, 120, 200]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 32 × 16 baseline JPEG: red on the left, blue on the right. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAQACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDCooorzj7Ey6KKK/Qj4Y//2Q==',
  'base64',
);

/** The JPEG with an EXIF orientation (an APP1 segment after its start marker), as phones write. */
function withOrientation(jpeg: Buffer, orientation: number) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22); // no next IFD
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), head, body, jpeg.subarray(2)]);
}

/** An image as `load` would have been given it. */
function refOf(fileId: string, bytes: Buffer): ImageRef {
  const s = sniff(bytes);
  return {
    kind: 'image',
    fileId,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mime: s.mime as ImageRef['mime'],
    width: s.width ?? 0,
    height: s.height ?? 0,
  };
}

/** Each page's content stream (inflated), in page order: the ones that draw. */
function pageStreams(pdf: Buffer): string[] {
  const out: string[] = [];
  for (const m of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let s: string;
    try {
      s = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    if (/^1 0 0 -1 0 [\d.]+ cm/.test(s)) out.push(s);
  }
  return out;
}

/** Every image drawn on a page: its box (top-down points, as pdfkit lays out) and its name. */
function drawn(stream: string) {
  return [...stream.matchAll(/([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\n\/(I\d+) Do/g)].map(
    (m) => ({
      width: Number(m[1]),
      height: -Number(m[2]),
      x: Number(m[3]),
      // pdfkit flips the image: its matrix starts at the box's bottom edge.
      y: Number(m[4]) + Number(m[2]),
      name: m[5],
    }),
  );
}

/** Where each line of text starts, measured from the page's top. */
const textTops = (stream: string, pageHeight = 841.89) =>
  [...stream.matchAll(/1 0 0 1 [-\d.]+ ([-\d.]+) Tm/g)].map((m) => pageHeight - Number(m[1]));

const meta = (images: Record<string, Buffer>) => ({
  lang: 'en' as const,
  author: 'A business',
  createdAt: new Date('2026-01-02T03:04:05Z'),
  images: new Map(Object.entries(images)),
});

const PNG = png(40, 30);
const P = refOf('png-1', PNG);
const J = refOf('jpg-1', JPEG);
const TURNED = withOrientation(JPEG, 6);
const T = refOf('jpg-6', TURNED);

/* ── The layout ───────────────────────────────────────────────────────────── */

describe('image blocks in the layout', () => {
  it('fills defaults and reads as lines: [Image: alt], captions, [QR: data], header and footer images', () => {
    const layout = DocumentLayout.parse({
      title: 'T',
      header: { image: { image: P, height: 24 }, left: 'hidden by the logo', right: 'A-1' },
      footer: { image: { image: J, height: 12, side: 'right' }, left: 'Page {page}' },
      blocks: [
        { type: 'image', image: P, alt: 'The logo', caption: 'Our studio' },
        {
          type: 'images',
          items: [
            { image: J, alt: 'Kitchen', caption: 'Before' },
            { image: T, alt: 'Kitchen after' },
          ],
        },
        { type: 'qr', data: 'upi://pay?pa=a@b', caption: 'Scan to pay' },
      ],
    });
    expect(layout.header?.image?.side).toBe('left');
    expect(layout.blocks[0]).toMatchObject({ align: 'center' });
    expect(layout.blocks[1]).toMatchObject({ columns: 2 });
    expect(layout.blocks[2]).toMatchObject({ size: 108, errorCorrection: 'M', align: 'center' });
    expect(layoutLines(layout)).toEqual([
      '[Image: header]  A-1',
      '[Image: The logo]',
      'Our studio',
      '[Image: Kitchen]',
      'Before',
      '[Image: Kitchen after]',
      '[QR: upi://pay?pa=a@b]',
      'Scan to pay',
      '[Image: footer]  Page {page}',
    ]);
    expect(imageRefsOf(layout).map((i) => [i.ref.fileId, i.path.join('.')])).toEqual([
      ['png-1', 'header.image'],
      ['png-1', 'blocks.0.image'],
      ['jpg-1', 'blocks.1.items.0.image'],
      ['jpg-6', 'blocks.1.items.1.image'],
      ['jpg-1', 'footer.image'],
    ]);
  });

  it('refuses each field out of its range, with its path', () => {
    const issue = (block: object, header?: object) => {
      const r = DocumentLayout.safeParse({ title: 'T', header, blocks: [block] });
      expect(r.success, JSON.stringify(block)).toBe(false);
      return r.error?.issues.map((i) => i.path.join('.')) ?? [];
    };
    expect(issue({ type: 'images', items: [{ image: P, alt: 'a' }], columns: 5 })).toContain(
      'blocks.0.columns',
    );
    expect(issue({ type: 'images', items: [] })).toContain('blocks.0.items');
    expect(issue({ type: 'images', items: Array(61).fill({ image: P, alt: 'a' }) })).toContain(
      'blocks.0.items',
    );
    expect(issue({ type: 'qr', data: 'x', size: 50 })).toContain('blocks.0.size');
    expect(issue({ type: 'qr', data: 'x', size: 300 })).toContain('blocks.0.size');
    expect(issue({ type: 'qr', data: 'x'.repeat(1001) })).toContain('blocks.0.data');
    expect(issue({ type: 'image', image: P, alt: 'a'.repeat(201) })).toContain('blocks.0.alt');
    expect(issue({ type: 'image', image: P, alt: 'a', caption: 'c'.repeat(501) })).toContain(
      'blocks.0.caption',
    );
    expect(issue({ type: 'image', image: { ...P, mime: 'image/svg+xml' }, alt: 'a' })).toContain(
      'blocks.0.image.mime',
    );
    expect(issue({ type: 'image', image: P }, undefined)).toContain('blocks.0.alt');
    expect(
      issue({ type: 'rule' }, { image: { image: P, height: 60 } }).some((p) =>
        p.startsWith('header.image.height'),
      ),
    ).toBe(true);
  });

  it('a QR text too long for its correction level is refused when asked: qr_too_long', () => {
    const r = DocumentLayout.safeParse({
      title: 'T',
      blocks: [{ type: 'qr', data: 'ఆ'.repeat(600), errorCorrection: 'H' }],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(['blocks', 0, 'data']);
    expect(r.error?.issues[0].message).toMatch(/^qr_too_long/);
    // The same text at a lower level is fine as long as it fits.
    expect(
      DocumentLayout.safeParse({ title: 'T', blocks: [{ type: 'qr', data: 'ఆ'.repeat(300) }] })
        .success,
    ).toBe(true);
  });

  it('names only images its load was given (same file, same SHA-256), and no more than the limit', () => {
    const layout = DocumentLayout.parse({
      title: 'T',
      blocks: [
        { type: 'image', image: P, alt: 'a' },
        { type: 'image', image: P, alt: 'again' },
      ],
    });
    const limits = imageLimits({});
    const given = new Map([[P.fileId, P]]);
    expect(checkLayoutImages(layout, given, limits)).toEqual([P]);
    const status = (fn: () => unknown) => {
      try {
        fn();
        return undefined;
      } catch (e) {
        return (e as { getResponse(): { error: string } }).getResponse().error;
      }
    };
    expect(status(() => checkLayoutImages(layout, new Map(), limits))).toBe('image_not_loaded');
    expect(
      status(() =>
        checkLayoutImages(layout, new Map([[P.fileId, { ...P, sha256: 'f'.repeat(64) }]]), limits),
      ),
    ).toBe('image_not_loaded');
    expect(status(() => checkLayoutImages(layout, given, { ...limits, maxCount: 1 }))).toBe(
      'too_many_images',
    );
  });

  it('the limits are deployment settings with defaults', () => {
    expect(imageLimits({})).toEqual({
      maxCount: 200,
      maxBytes: 10 * 1024 * 1024,
      maxPixels: 40_000_000,
      maxTotalBytes: 60 * 1024 * 1024,
    });
    expect(
      imageLimits({ DOCUMENTS_IMAGES_MAX: '3', DOCUMENTS_IMAGE_MAX_BYTES: '1000' }),
    ).toMatchObject({ maxCount: 3, maxBytes: 1000 });
    expect(() => imageLimits({ DOCUMENTS_IMAGE_MAX_PIXELS: '-1' })).toThrow(/positive/);
  });
});

/* ── The PDF engine ───────────────────────────────────────────────────────── */

describe('the PDF engine draws images', () => {
  const render = (blocks: DocumentBlock[], images: Record<string, Buffer>, extra = {}) =>
    createPdfEngine().render(
      DocumentLayout.parse({ title: 'Images', blocks, ...extra }),
      meta(images),
    );

  it('a PNG, a JPEG and a portrait phone JPEG (EXIF 6): upright, at their proportions, inside their boxes', async () => {
    const out = await render(
      [
        { type: 'image', image: P, width: 120, alt: 'png' },
        { type: 'image', image: J, width: 64, height: 400, alt: 'jpeg in a tall box' },
        { type: 'image', image: T, width: 100, alt: 'turned' },
        { type: 'spacer', size: 300 },
        { type: 'image', image: J, alt: 'full width', align: 'left' },
      ],
      { [P.fileId]: PNG, [J.fileId]: JPEG, [T.fileId]: TURNED },
    );
    expect(out.pages).toBe(2);
    const text = out.bytes.toString('latin1');
    // Each file is embedded once, however often it is drawn.
    expect((text.match(/\/Subtype \/Image/g) ?? []).length).toBe(3);
    // Each picture's alternate text, marked for readers.
    expect(pageStreams(out.bytes)[0]).toContain('/Alt (png)');
    const [first, second] = pageStreams(out.bytes).map(drawn);
    // 40 × 30 at 120 wide: 90 high, centred in the 499.28-wide content.
    expect(first[0]).toMatchObject({ width: 120, height: 90 });
    expect(first[0].x).toBeCloseTo(48 + (499.28 - 120) / 2, 1);
    // 32 × 16 fitted into 64 × 400: 64 × 32, never stretched to the box's height.
    expect(first[1]).toMatchObject({ width: 64, height: 32 });
    // The phone photo is 32 × 16 as stored, 16 × 32 as held: 100 wide is 200 high. pdfkit
    // turns it a quarter (its matrix, 0 1 -1 0) and draws it 200 × 100 along its stored axes.
    expect(first).toHaveLength(3);
    expect(first[2]).toMatchObject({ width: 200, height: 100 });
    expect(pageStreams(out.bytes)[0]).toMatch(
      /\/Alt \(turned\)\n>> BDC\nq\n0 1 -1 0 [-\d.]+ [-\d.]+ cm\n200 0 0 -100 /,
    );
    // The full-width image did not fit under the others: it starts the next page.
    expect(second[0].width).toBeCloseTo(499.28, 1);
    expect(second[0].height).toBeCloseTo(499.28 / 2, 1);
    expect(second[0].y).toBeCloseTo(48, 1);
  });

  it('a turned photo takes its upright height: what follows it moves down by that', async () => {
    const textBelow = async (image: ImageRef, bytes: Buffer) => {
      const out = await render(
        [
          { type: 'image', image, width: 100, alt: 'x' },
          { type: 'text', text: 'After' },
        ],
        { [image.fileId]: bytes },
      );
      return textTops(pageStreams(out.bytes)[0])[0];
    };
    // Upright: 100 × 50. Turned (EXIF 6): 100 × 200. The text after is 150 points lower.
    expect((await textBelow(T, TURNED)) - (await textBelow(J, JPEG))).toBeCloseTo(150, 1);
  });

  it('an image taller than a page is scaled down to fit one page', async () => {
    const tall = png(10, 400);
    const out = await render([{ type: 'image', image: refOf('tall', tall), alt: 'tall' }], {
      tall,
    });
    expect(out.pages).toBe(1);
    const [box] = drawn(pageStreams(out.bytes)[0]);
    expect(box.height).toBeCloseTo(841.89 - 96, 1);
    expect(box.width).toBeCloseTo(((841.89 - 96) * 10) / 400, 1);
  });

  it('a grid of 13 photos in 3 columns runs onto a second page without splitting a row; the header and footer repeat', async () => {
    const out = await render(
      [
        {
          type: 'images',
          columns: 3,
          height: 150,
          items: Array.from({ length: 13 }, (_, i) => ({
            image: i % 2 ? J : P,
            alt: `Photo ${i + 1}`,
            caption: `Photo ${i + 1}`,
          })),
        },
      ],
      { [P.fileId]: PNG, [J.fileId]: JPEG },
      {
        header: { image: { image: P, height: 20 }, right: 'A report' },
        footer: { right: 'Page {page} of {pages}' },
      },
    );
    expect(out.pages).toBe(2);
    const pages = pageStreams(out.bytes).map(drawn);
    // Four rows of three on the first page and the header logo; the last photo and the logo next.
    expect(pages.map((p) => p.length)).toEqual([13, 2]);
    // A picture is centred in its cell: the cell's top is above it by half the room left.
    const rows = (boxes: ReturnType<typeof drawn>) =>
      new Set(boxes.filter((b) => b.y > 40).map((b) => Math.round(b.y - (150 - b.height) / 2)))
        .size;
    expect(rows(pages[0])).toBe(4);
    expect(rows(pages[1])).toBe(1);
    // Each picture inside its 161-wide, 150-high cell.
    for (const b of pages[0].filter((x) => x.y > 40)) {
      expect(b.width).toBeLessThanOrEqual(161.1);
      expect(b.height).toBeLessThanOrEqual(150.01);
    }
    // The header and footer text on both pages (two lines of text each beside the captions).
    for (const s of pageStreams(out.bytes)) expect(textTops(s).length).toBeGreaterThan(2);
  });

  it('a header logo shows on every page of a 3-page document, and the content never runs under it', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({
      type: 'text' as const,
      text: `Line ${i + 1}`,
    }));
    const out = await render(
      lines,
      { [P.fileId]: PNG },
      {
        header: { image: { image: P, height: 48, side: 'right' }, left: 'A business' },
      },
    );
    expect(out.pages).toBe(3);
    for (const s of pageStreams(out.bytes)) {
      const [logo] = drawn(s);
      // 40 × 30 at 48 high: 64 wide, at the right edge, from 8 to 56 points down.
      expect(logo.height).toBe(48);
      expect(logo.y).toBe(8);
      expect(logo.x + logo.width).toBeCloseTo(48 + 499.28, 1);
      // Every line of content starts below the logo. The header's own text, beside the logo
      // and drawn last, is left out.
      const tops = textTops(s).slice(0, -1);
      expect(Math.min(...tops)).toBeGreaterThan(56);
    }
  });

  it('a QR code of a 300-character payment link is drawn as the encoder’s matrix, with its quiet zone', async () => {
    const data = `upi://pay?pa=studio@bank&am=1500.00&cu=INR&tn=`.padEnd(300, 'A');
    expect(data).toHaveLength(300);
    const out = await render([{ type: 'qr', data, size: 216, align: 'left' }], {});
    const stream = pageStreams(out.bytes)[0];
    const rects = [...stream.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re/g)].map((m) =>
      m.slice(1, 5).map(Number),
    );
    const { modules } = QRCode.create(data, { errorCorrectionLevel: 'M' });
    const n = modules.size;
    const unit = 216 / (n + 8);
    const seen = Array.from({ length: n }, () => Array(n).fill(false));
    for (const [x, y, w, h] of rects) {
      expect(h).toBeCloseTo(unit, 3);
      const r = Math.round((y - 48) / unit) - 4;
      const c0 = Math.round((x - 48) / unit) - 4;
      for (let c = c0; c < c0 + Math.round(w / unit); c++) seen[r][c] = true;
    }
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) expect(seen[r][c], `${r},${c}`).toBe(!!modules.get(r, c));
    // The quiet zone: nothing drawn in the first and last four modules.
    for (const [x, y] of rects) {
      expect(x).toBeGreaterThanOrEqual(48 + 4 * unit - 0.01);
      expect(y).toBeGreaterThanOrEqual(48 + 4 * unit - 0.01);
    }
  });

  it('captions in Hindi and Telugu are shaped and mapped back to their letters', async () => {
    const out = await render(
      [
        { type: 'image', image: P, alt: 'a', caption: 'श्री प्रेम क्षत्रिय' },
        { type: 'images', items: [{ image: P, alt: 'b', caption: 'శ్రీ ప్రేమ కృష్ణ' }] },
        { type: 'qr', data: 'x', caption: 'స్త్రీ' },
      ],
      { [P.fileId]: PNG },
    );
    const text = out.bytes.toString('latin1');
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansDevanagari/);
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansTelugu/);
    const all = [...text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
      .map((m) => {
        try {
          return inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
        } catch {
          return '';
        }
      })
      .join('\n')
      .toLowerCase();
    // श, ष (in क्ष), శ, ర: the glyphs drawn name the letters they stand for.
    for (const cp of ['0936', '0937', '0c36', '0c30']) expect(all).toContain(cp);
  }, 30_000);

  it('refuses to draw an image whose bytes were not read', async () => {
    await expect(render([{ type: 'image', image: P, alt: 'a' }], {})).rejects.toThrow(
      /image_unavailable/,
    );
  });

  it('the fake engine writes the image lines', async () => {
    const out = await createFakeEngine().render(
      DocumentLayout.parse({
        title: 'T',
        blocks: [
          { type: 'image', image: P, alt: 'Logo' },
          { type: 'qr', data: 'https://example.test/x' },
        ],
      }),
      meta({}),
    );
    const text = out.bytes.toString('latin1');
    expect(text).toContain('([Image: Logo])');
    expect(text).toContain('([QR: https://example.test/x])');
  });
});
