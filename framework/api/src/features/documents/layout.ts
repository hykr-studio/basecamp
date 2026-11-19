import QRCode from 'qrcode';
import { z } from 'zod';

/**
 * What a document's `render` returns: its pages' content as blocks, in the reader's language
 * already (money, dates and labels are formatted by the template). Engine-neutral: the PDF
 * engine lays it out with shaped text, the fake engine writes its lines.
 */

const Text = z.string().max(10_000);
const Align = z.enum(['left', 'center', 'right']);
export type Align = z.infer<typeof Align>;

export const TableColumn = z.object({
  label: Text,
  /** Its share of the width: columns of width 2 and 1 take two thirds and one third. */
  width: z.number().positive().max(100).default(1),
  align: Align.default('left'),
});

export const TableRow = z.object({
  cells: z.array(Text).max(12),
  /** A line; a group's heading (bold, shaded); a subtotal (bold, with a rule above). */
  kind: z.enum(['line', 'group', 'subtotal']).default('line'),
  /** How far its first cell is indented (a line under a group under a group: 2). */
  indent: z.number().int().min(0).max(8).default(0),
});

/**
 * An image a document shows: one `load` was given by `ctx.image` (a file the requester may open,
 * PNG or JPEG), named by its file and the SHA-256 of its bytes then. A template never types one:
 * a layout naming an image `load` was not given is refused (`image_not_loaded`).
 */
export const ImageRef = z.object({
  kind: z.literal('image'),
  fileId: z.string().min(1).max(200),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.enum(['image/png', 'image/jpeg']),
  /** Pixels, as stored (before a JPEG's EXIF orientation turns it). */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type ImageRef = z.infer<typeof ImageRef>;

const Caption = z.string().max(500);
const Alt = z.string().max(200);
/** Points; a box an image is fitted into. */
const Extent = z.number().positive().max(2000);

/** QR error correction: how much of the code may be damaged and still read. */
export const QrCorrection = z.enum(['L', 'M', 'Q', 'H']);

export const DocumentBlock = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    text: Text,
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  }),
  z.object({
    type: z.literal('text'),
    text: Text,
    size: z.number().min(6).max(36).optional(),
    bold: z.boolean().optional(),
    muted: z.boolean().optional(),
    align: Align.optional(),
  }),
  /** Label and value pairs: a document's number, date, who it is for. */
  z.object({
    type: z.literal('fields'),
    items: z.array(z.object({ label: Text, value: Text })).max(200),
    columns: z.union([z.literal(1), z.literal(2)]).default(2),
  }),
  /** Rows under a header that repeats on every page the table runs onto. */
  z.object({
    type: z.literal('table'),
    columns: z.array(TableColumn).min(1).max(12),
    rows: z.array(TableRow).max(5000),
  }),
  /** Right-aligned label and amount rows under a table. */
  z.object({
    type: z.literal('totals'),
    rows: z.array(z.object({ label: Text, value: Text, strong: z.boolean().optional() })).max(50),
  }),
  z.object({ type: z.literal('spacer'), size: z.number().min(0).max(400).default(12) }),
  z.object({ type: z.literal('rule') }),
  z.object({ type: z.literal('pageBreak') }),
  /**
   * One picture, fitted into `width` × `height` at its own proportions (neither: the content
   * width; one: the other follows), never stretched or cropped, its caption under it.
   */
  z.object({
    type: z.literal('image'),
    image: ImageRef,
    width: Extent.optional(),
    height: Extent.optional(),
    align: Align.default('center'),
    caption: Caption.optional(),
    alt: Alt,
  }),
  /** Pictures in a grid of `columns`, each fitted into its cell; a row never splits. */
  z.object({
    type: z.literal('images'),
    items: z
      .array(z.object({ image: ImageRef, caption: Caption.optional(), alt: Alt }))
      .min(1)
      .max(60),
    columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2),
    /** Each cell's height. Default: its width × 3/4. */
    height: Extent.optional(),
  }),
  /** A QR code of `data` (a payment or share link), drawn as vector squares. */
  z.object({
    type: z.literal('qr'),
    data: z.string().min(1).max(1000),
    /** The square's side in points, quiet zone included. */
    size: z.number().min(72).max(288).default(108),
    align: Align.default('center'),
    caption: Caption.optional(),
    errorCorrection: QrCorrection.default('M'),
  }),
]);
export type DocumentBlock = z.input<typeof DocumentBlock>;

/**
 * A line at the top or bottom of every page. `{page}` and `{pages}` are filled in. An image (a
 * logo) sits on its `side`, and the text on that side is not drawn.
 */
const PageLine = z.object({
  left: Text.optional(),
  right: Text.optional(),
  image: z
    .object({
      image: ImageRef,
      height: z.number().min(12).max(48),
      side: z.enum(['left', 'right']).default('left'),
    })
    .optional(),
});

export const DocumentLayout = z
  .object({
    /** The PDF's title (its metadata); shown only where a block shows it. */
    title: Text.min(1),
    page: z
      .object({
        size: z.enum(['A4', 'A5', 'LETTER']).default('A4'),
        /** Points (1/72 inch) on every side. */
        margin: z.number().min(18).max(144).default(48),
      })
      .default({ size: 'A4', margin: 48 }),
    header: PageLine.optional(),
    footer: PageLine.optional(),
    blocks: z.array(DocumentBlock).max(10_000),
  })
  .superRefine((layout, ctx) => {
    layout.blocks.forEach((b, i) => {
      if (b.type === 'qr') {
        const why = qrProblem(b.data, b.errorCorrection);
        if (why) ctx.addIssue({ code: 'custom', path: ['blocks', i, 'data'], message: why });
        return;
      }
      if (b.type !== 'table') return;
      b.rows.forEach((r, j) => {
        if (r.cells.length !== b.columns.length)
          ctx.addIssue({
            code: 'custom',
            path: ['blocks', i, 'rows', j, 'cells'],
            message: `a row has ${r.cells.length} cells; the table has ${b.columns.length} columns`,
          });
      });
    });
  });
/** A layout as a template writes it (defaults may be left out). */
export type DocumentLayout = z.input<typeof DocumentLayout>;
/** A layout checked, with its defaults filled in: what an engine draws. */
export type CheckedLayout = z.output<typeof DocumentLayout>;

/** Why this text makes no QR code at this correction level (too long), or undefined. */
export function qrProblem(data: string, level: z.infer<typeof QrCorrection>): string | undefined {
  try {
    QRCode.create(data, { errorCorrectionLevel: level });
    return undefined;
  } catch (e) {
    return `qr_too_long: ${data.length} characters do not fit a QR code at correction level ${level} (${e instanceof Error ? e.message : String(e)})`;
  }
}

/** A QR code's modules: `size` × `size`, `dark(row, col)`. */
export function qrMatrix(data: string, level: z.infer<typeof QrCorrection>) {
  const { modules } = QRCode.create(data, { errorCorrectionLevel: level });
  return { size: modules.size, dark: (r: number, c: number) => !!modules.get(r, c) };
}

/** Every image a layout shows, in order, with where it is (its JSON path). */
export function imageRefsOf(
  layout: Pick<CheckedLayout, 'blocks' | 'header' | 'footer'>,
): { ref: ImageRef; path: (string | number)[] }[] {
  const out: { ref: ImageRef; path: (string | number)[] }[] = [];
  if (layout.header?.image) out.push({ ref: layout.header.image.image, path: ['header', 'image'] });
  layout.blocks.forEach((b, i) => {
    if (b.type === 'image') out.push({ ref: b.image, path: ['blocks', i, 'image'] });
    if (b.type === 'images')
      for (const [j, it] of b.items.entries())
        out.push({ ref: it.image, path: ['blocks', i, 'items', j, 'image'] });
  });
  if (layout.footer?.image) out.push({ ref: layout.footer.image.image, path: ['footer', 'image'] });
  return out;
}

/** `{page}` and `{pages}` in a header or footer line. */
export const pageText = (text: string, page: number, pages: number) =>
  text.replaceAll('{page}', String(page)).replaceAll('{pages}', String(pages));

/**
 * The layout's words as lines, in reading order: what the fake engine writes, and what tests
 * and the assistant can check a document says.
 */
export function layoutLines(layout: CheckedLayout): string[] {
  const out: string[] = [];
  const pageLine = (line: CheckedLayout['header'], where: 'header' | 'footer') => {
    if (!line) return;
    const image = line.image ? `[Image: ${where}]` : undefined;
    // The text on the image's side is not drawn.
    const left = line.image?.side === 'left' ? undefined : line.left;
    const right = line.image?.side === 'right' ? undefined : line.right;
    out.push([image, left, right].filter(Boolean).join('  '));
  };
  const picture = (alt: string, caption?: string) => {
    out.push(`[Image: ${alt}]`);
    if (caption) out.push(...caption.split('\n'));
  };
  pageLine(layout.header, 'header');
  for (const b of layout.blocks) {
    switch (b.type) {
      case 'heading':
      case 'text':
        out.push(...b.text.split('\n'));
        break;
      case 'fields':
        for (const f of b.items) out.push(`${f.label}: ${f.value}`);
        break;
      case 'table':
        out.push(b.columns.map((c) => c.label).join(' | '));
        for (const r of b.rows) out.push(`${'  '.repeat(r.indent)}${r.cells.join(' | ')}`);
        break;
      case 'totals':
        for (const r of b.rows) out.push(`${r.label}: ${r.value}`);
        break;
      case 'image':
        picture(b.alt, b.caption);
        break;
      case 'images':
        for (const it of b.items) picture(it.alt, it.caption);
        break;
      case 'qr':
        out.push(`[QR: ${b.data}]`);
        if (b.caption) out.push(...b.caption.split('\n'));
        break;
      case 'spacer':
      case 'rule':
      case 'pageBreak':
        out.push('');
        break;
    }
  }
  pageLine(layout.footer, 'footer');
  return out;
}
