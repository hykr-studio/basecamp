import PDFDocument from 'pdfkit';
import { type Align, type CheckedLayout, type ImageRef, pageText, qrMatrix } from '../layout.js';
import type { DocumentEngine, Rendered, RenderMeta } from './engine.js';
import { fontName, type LoadedFont, loadFonts, type Script, scriptRuns } from './fonts.js';

/** Neutral colours: the application's branding is not the framework's. */
const COLOR = { text: '#111827', muted: '#6b7280', rule: '#d1d5db', fill: '#f3f4f6' };
const SIZE = { text: 10, small: 8, table: 9, h1: 18, h2: 14, h3: 11.5 };
const HEADING = { 1: SIZE.h1, 2: SIZE.h2, 3: SIZE.h3 } as const;
const PAD = { x: 4, y: 3 };
/** How far one level of a table row's indent moves its first cell. */
const INDENT = 10;
/** Between a picture and its caption, between grid cells, and between a header image and content. */
const GAP = { caption: 4, cell: 8, edge: 6 };
/** A QR code's quiet zone, in modules, on every side (the standard's four). */
const QUIET = 4;

/** An image pdfkit opened once (embedded once, however often it is drawn). */
interface Opened {
  width: number;
  height: number;
  /** A JPEG's EXIF orientation (1 to 8); pdfkit turns the image by it when drawing. */
  orientation?: number;
}

type Checked<T extends CheckedLayout['blocks'][number]['type']> = Extract<
  CheckedLayout['blocks'][number],
  { type: T }
>;

/** Part of a line set in one font. */
interface Piece {
  font: LoadedFont;
  text: string;
  width: number;
}

/** One laid-out line: its pieces, its width, and its height from the tallest font in it. */
interface Line {
  pieces: Piece[];
  width: number;
  ascent: number;
  height: number;
}

interface TextStyle {
  size: number;
  bold?: boolean;
  color?: string;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Lays a checked layout out on pages and writes the PDF. Lines are broken here, not by pdfkit,
 * so one line can hold several scripts (each piece in its own font, all on one baseline).
 */
class PdfWriter {
  private readonly doc: PDFKit.PDFDocument;
  private readonly left: number;
  private readonly width: number;
  private readonly top: number;
  private readonly bottom: number;
  private y: number;
  private readonly opened = new Map<string, Opened>();

  constructor(
    private readonly layout: CheckedLayout,
    private readonly meta: RenderMeta,
    private readonly fonts: ReadonlyMap<string, LoadedFont>,
  ) {
    this.doc = new PDFDocument({
      size: layout.page.size,
      margin: layout.page.margin,
      bufferPages: true,
      lang: meta.lang,
      info: {
        Title: layout.title,
        Author: meta.author ?? '',
        Creator: 'Basecamp',
        Producer: 'Basecamp',
        CreationDate: meta.createdAt,
      },
    });
    for (const f of fonts.values()) this.doc.registerFont(f.name, f.font as never);
    const page = this.doc.page;
    this.left = page.margins.left;
    this.width = page.width - page.margins.left - page.margins.right;
    // A header or footer image taller than its margin pushes the content in: never under it.
    const head = this.pageImageBox('header');
    const foot = this.pageImageBox('footer');
    this.top = Math.max(page.margins.top, head ? head.y + head.height + GAP.edge : 0);
    this.bottom = Math.min(
      page.height - page.margins.bottom,
      foot ? foot.y - GAP.edge : Number.POSITIVE_INFINITY,
    );
    this.y = this.top;
  }

  /** Where a header's or footer's image sits on every page (its top and height), if it has one. */
  private pageImageBox(where: 'header' | 'footer') {
    const image = this.layout[where]?.image;
    if (!image) return undefined;
    const page = this.doc.page;
    const margin = this.layout.page.margin;
    const inset = Math.max((margin - image.height) / 2, 8);
    const y = where === 'header' ? inset : page.height - inset - image.height;
    return { y, height: image.height };
  }

  /** An image's bytes, opened once per file. */
  private open(ref: ImageRef): Opened {
    const had = this.opened.get(ref.fileId);
    if (had) return had;
    const bytes = this.meta.images?.get(ref.fileId);
    if (!bytes) throw new Error(`image_unavailable: ${ref.fileId} (its bytes were not read)`);
    // pdfkit's types leave openImage out; it parses the image once and embeds it on first use.
    const image = (this.doc as unknown as { openImage(src: Buffer): Opened }).openImage(bytes);
    this.opened.set(ref.fileId, image);
    return image;
  }

  /** An image's width and height as it shows: a JPEG's EXIF orientation 5 to 8 turns it. */
  private shape(ref: ImageRef): { width: number; height: number } {
    const image = this.open(ref);
    const turned = (image.orientation ?? 1) > 4;
    return turned
      ? { width: image.height, height: image.width }
      : { width: image.width, height: image.height };
  }

  /**
   * Draw an image fitted into the box at (x, y) of w × h, at its own proportions, centred in it;
   * its alternate text marked for readers.
   */
  private drawImage(ref: ImageRef, x: number, y: number, w: number, h: number, alt?: string) {
    const image = this.open(ref);
    if (alt) this.doc.markContent('Span', { alt });
    this.doc.image(image as never, x, y, { fit: [w, h], align: 'center', valign: 'center' });
    if (alt) this.doc.endMarkedContent();
  }

  private font(script: Script, bold: boolean): LoadedFont {
    const f = this.fonts.get(fontName(script, bold));
    if (!f) throw new Error(`No font ${fontName(script, bold)}`);
    return f;
  }

  /** The text in pieces of one font each, measured at this size. */
  private pieces(text: string, size: number, bold: boolean): Piece[] {
    const has = (s: Script, cp: number) => this.font(s, bold).font.hasGlyphForCodePoint(cp);
    return scriptRuns(text, has).map((run) => {
      const font = this.font(run.script, bold);
      this.doc.font(font.name).fontSize(size);
      return { font, text: run.text, width: this.doc.widthOfString(run.text) };
    });
  }

  private lineOf(pieces: Piece[], size: number, bold: boolean): Line {
    // Neighbours in one font become one piece (fewer text operators).
    const merged: Piece[] = [];
    for (const p of pieces) {
      const last = merged.at(-1);
      if (last && last.font === p.font)
        merged.push({
          ...merged.pop(),
          text: last.text + p.text,
          width: last.width + p.width,
        } as Piece);
      else merged.push({ ...p });
    }
    while (merged.length && /^\s*$/.test(merged.at(-1)?.text ?? '')) merged.pop();
    const fonts = merged.length ? merged.map((p) => p.font) : [this.font('latin', bold)];
    const ascent = (Math.max(...fonts.map((f) => f.ascent)) * size) / 1000;
    const descent = (Math.max(...fonts.map((f) => f.descent)) * size) / 1000;
    return {
      pieces: merged,
      width: merged.reduce((w, p) => w + p.width, 0),
      ascent,
      height: ascent + descent,
    };
  }

  /** Break text into lines that fit `width`, at spaces (and inside a word too long for a line). */
  private wrap(text: string, width: number, style: TextStyle): Line[] {
    const { size } = style;
    const bold = style.bold ?? false;
    const lines: Line[] = [];
    for (const paragraph of text.split('\n')) {
      let current: Piece[] = [];
      let used = 0;
      const flush = () => {
        lines.push(this.lineOf(current, size, bold));
        current = [];
        used = 0;
      };
      const add = (pieces: Piece[], w: number) => {
        current.push(...pieces);
        used += w;
      };
      for (const token of paragraph.split(/(\s+)/).filter(Boolean)) {
        if (/^\s+$/.test(token)) {
          if (!current.length) continue;
          const space = this.pieces(' ', size, bold);
          const w = space[0]?.width ?? 0;
          if (used + w > width) flush();
          else add(space, w);
          continue;
        }
        const pieces = this.pieces(token, size, bold);
        const w = pieces.reduce((s, p) => s + p.width, 0);
        if (w <= width) {
          if (used + w > width && current.length) flush();
          add(pieces, w);
          continue;
        }
        // A word wider than the line: broken between graphemes.
        for (const { segment } of graphemes.segment(token)) {
          const part = this.pieces(segment, size, bold);
          const pw = part.reduce((s, p) => s + p.width, 0);
          if (used + pw > width && current.length) flush();
          add(part, pw);
        }
      }
      flush();
    }
    return lines;
  }

  private drawLine(
    line: Line,
    x: number,
    top: number,
    width: number,
    align: Align,
    style: TextStyle,
  ) {
    let at =
      align === 'right'
        ? x + width - line.width
        : align === 'center'
          ? x + (width - line.width) / 2
          : x;
    const baseline = top + line.ascent;
    for (const p of line.pieces) {
      this.doc
        .font(p.font.name)
        .fontSize(style.size)
        .fillColor(style.color ?? COLOR.text)
        .text(p.text, at, baseline, { lineBreak: false, baseline: 'alphabetic' });
      at += p.width;
    }
  }

  /** Lines one under another from `top`; returns their height. */
  private drawLines(
    lines: Line[],
    x: number,
    top: number,
    width: number,
    align: Align,
    style: TextStyle,
  ) {
    let y = top;
    for (const line of lines) {
      this.drawLine(line, x, y, width, align, style);
      y += line.height;
    }
    return y - top;
  }

  private newPage() {
    this.doc.addPage();
    this.y = this.top;
  }

  /** Room for `height` more on this page, or a new page. */
  private ensure(height: number) {
    if (this.y + height > this.bottom && this.y > this.top) this.newPage();
  }

  private rule(y: number, x = this.left, width = this.width) {
    this.doc
      .save()
      .moveTo(x, y)
      .lineTo(x + width, y)
      .lineWidth(0.6)
      .strokeColor(COLOR.rule)
      .stroke()
      .restore();
  }

  private fill(x: number, y: number, width: number, height: number) {
    this.doc.save().rect(x, y, width, height).fillColor(COLOR.fill).fill().restore();
  }

  /* ── Blocks ──────────────────────────────────────────────────────────────── */

  private text(text: string, style: TextStyle, align: Align = 'left', after = 0) {
    for (const line of this.wrap(text, this.width, style)) {
      this.ensure(line.height);
      this.drawLine(line, this.left, this.y, this.width, align, style);
      this.y += line.height;
    }
    this.y += after;
  }

  private heading(b: Checked<'heading'>) {
    const size = HEADING[b.level];
    if (this.y > this.top) this.y += size * 0.6;
    this.text(b.text, { size, bold: true }, 'left', size * 0.35);
  }

  private fields(b: Checked<'fields'>) {
    const gap = 16;
    const cols = b.columns;
    const colWidth = (this.width - gap * (cols - 1)) / cols;
    const label = { size: SIZE.small, color: COLOR.muted };
    const value = { size: SIZE.text };
    for (let i = 0; i < b.items.length; i += cols) {
      const row = b.items.slice(i, i + cols).map((item) => ({
        label: this.wrap(item.label, colWidth, label),
        value: this.wrap(item.value, colWidth, value),
      }));
      const height = Math.max(
        ...row.map((c) => [...c.label, ...c.value].reduce((h, l) => h + l.height, 0)),
      );
      this.ensure(height);
      row.forEach((c, j) => {
        const x = this.left + j * (colWidth + gap);
        const h = this.drawLines(c.label, x, this.y, colWidth, 'left', label);
        this.drawLines(c.value, x, this.y + h, colWidth, 'left', value);
      });
      this.y += height + 6;
    }
    this.y += 4;
  }

  private table(b: Checked<'table'>) {
    const total = b.columns.reduce((s, c) => s + c.width, 0);
    const widths = b.columns.map((c) => (this.width * c.width) / total);
    const xs = widths.map((_, i) => this.left + widths.slice(0, i).reduce((s, w) => s + w, 0));
    const size = SIZE.table;

    const cellsOf = (cells: string[], bold: boolean, indent: number) =>
      cells.map((text, i) => {
        const inset = i === 0 ? indent * INDENT : 0;
        const lines = this.wrap(text, Math.max(widths[i] - PAD.x * 2 - inset, 8), { size, bold });
        return { lines, inset, height: lines.reduce((h, l) => h + l.height, 0) };
      });
    const drawRow = (cells: ReturnType<typeof cellsOf>, bold: boolean) =>
      cells.forEach((c, i) => {
        const x = xs[i] + PAD.x + c.inset;
        const w = widths[i] - PAD.x * 2 - c.inset;
        this.drawLines(c.lines, x, this.y + PAD.y, w, b.columns[i].align, { size, bold });
      });

    const header = () => {
      const cells = cellsOf(
        b.columns.map((c) => c.label),
        true,
        0,
      );
      const height = Math.max(...cells.map((c) => c.height)) + PAD.y * 2;
      this.ensure(height);
      this.fill(this.left, this.y, this.width, height);
      drawRow(cells, true);
      this.y += height;
      this.rule(this.y);
    };

    header();
    for (const row of b.rows) {
      const bold = row.kind !== 'line';
      const cells = cellsOf(row.cells, bold, row.indent);
      const height = Math.max(...cells.map((c) => c.height)) + PAD.y * 2;
      if (this.y + height > this.bottom) {
        this.newPage();
        header();
      }
      if (row.kind === 'group') this.fill(this.left, this.y, this.width, height);
      if (row.kind === 'subtotal') this.rule(this.y);
      drawRow(cells, bold);
      this.y += height;
    }
    this.rule(this.y);
    this.y += 10;
  }

  private totals(b: Checked<'totals'>) {
    const width = Math.min(this.width, Math.max(220, this.width * 0.45));
    const x = this.left + this.width - width;
    const labelWidth = width * 0.55;
    for (const row of b.rows) {
      const style = { size: SIZE.text, bold: row.strong ?? false };
      const label = this.wrap(row.label, labelWidth - PAD.x, style);
      const value = this.wrap(row.value, width - labelWidth, style);
      const height =
        Math.max(...[label, value].map((ls) => ls.reduce((h, l) => h + l.height, 0))) + PAD.y * 2;
      this.ensure(height);
      if (row.strong) this.rule(this.y, x, width);
      this.drawLines(label, x, this.y + PAD.y, labelWidth - PAD.x, 'left', style);
      this.drawLines(value, x + labelWidth, this.y + PAD.y, width - labelWidth, 'right', style);
      this.y += height;
    }
    this.y += 8;
  }

  /** A caption's lines under a picture, `width` wide. */
  private captionLines(caption: string | undefined, width: number) {
    return caption ? this.wrap(caption, width, { size: SIZE.small, color: COLOR.muted }) : [];
  }

  private image(b: Checked<'image'>) {
    const shape = this.shape(b.image);
    const ratio = shape.width / shape.height;
    let w: number;
    let h: number;
    if (b.width && b.height) {
      // Fitted inside the box, never stretched.
      w = Math.min(b.width, b.height * ratio);
      h = w / ratio;
    } else if (b.width) {
      w = b.width;
      h = w / ratio;
    } else if (b.height) {
      h = b.height;
      w = h * ratio;
    } else {
      w = this.width;
      h = w / ratio;
    }
    // Never wider than the content, never taller than a page (with its caption).
    const caption = this.captionLines(b.caption, this.width);
    const captionHeight = caption.reduce((s, l) => s + l.height, 0);
    const room = this.bottom - this.top - (captionHeight ? captionHeight + GAP.caption : 0);
    const scale = Math.min(1, this.width / w, room / h);
    w *= scale;
    h *= scale;
    this.ensure(h + (captionHeight ? captionHeight + GAP.caption : 0));
    const x =
      b.align === 'left'
        ? this.left
        : b.align === 'right'
          ? this.left + this.width - w
          : this.left + (this.width - w) / 2;
    this.drawImage(b.image, x, this.y, w, h, b.alt);
    this.y += h;
    if (captionHeight) {
      this.y += GAP.caption;
      this.drawLines(caption, this.left, this.y, this.width, b.align, {
        size: SIZE.small,
        color: COLOR.muted,
      });
      this.y += captionHeight;
    }
    this.y += 10;
  }

  private images(b: Checked<'images'>) {
    const cols = b.columns;
    const cellWidth = (this.width - GAP.cell * (cols - 1)) / cols;
    const style = { size: SIZE.small, color: COLOR.muted };
    for (let i = 0; i < b.items.length; i += cols) {
      const row = b.items.slice(i, i + cols).map((item) => ({
        item,
        caption: this.captionLines(item.caption, cellWidth),
      }));
      const captionHeight = Math.max(
        0,
        ...row.map((c) => c.caption.reduce((s, l) => s + l.height, 0)),
      );
      const below = captionHeight ? captionHeight + GAP.caption : 0;
      // A row never splits: one taller than a page is made shorter to fit one.
      const cellHeight = Math.min(b.height ?? (cellWidth * 3) / 4, this.bottom - this.top - below);
      this.ensure(cellHeight + below);
      row.forEach((c, j) => {
        const x = this.left + j * (cellWidth + GAP.cell);
        this.drawImage(c.item.image, x, this.y, cellWidth, cellHeight, c.item.alt);
        if (c.caption.length)
          this.drawLines(
            c.caption,
            x,
            this.y + cellHeight + GAP.caption,
            cellWidth,
            'center',
            style,
          );
      });
      this.y += cellHeight + below + GAP.cell;
    }
    this.y += 4;
  }

  private qr(b: Checked<'qr'>) {
    const matrix = qrMatrix(b.data, b.errorCorrection);
    const caption = this.captionLines(b.caption, this.width);
    const captionHeight = caption.reduce((s, l) => s + l.height, 0);
    const size = Math.min(b.size, this.width);
    this.ensure(size + (captionHeight ? captionHeight + GAP.caption : 0));
    const x =
      b.align === 'left'
        ? this.left
        : b.align === 'right'
          ? this.left + this.width - size
          : this.left + (this.width - size) / 2;
    const unit = size / (matrix.size + QUIET * 2);
    const doc = this.doc.save();
    // Dark modules as squares, a row's neighbours joined into one rectangle.
    for (let r = 0; r < matrix.size; r++) {
      let c = 0;
      while (c < matrix.size) {
        if (!matrix.dark(r, c)) {
          c++;
          continue;
        }
        const from = c;
        while (c < matrix.size && matrix.dark(r, c)) c++;
        doc.rect(x + (QUIET + from) * unit, this.y + (QUIET + r) * unit, (c - from) * unit, unit);
      }
    }
    doc.fillColor('#000000').fill().restore();
    this.y += size;
    if (captionHeight) {
      this.y += GAP.caption;
      this.drawLines(caption, this.left, this.y, this.width, b.align, {
        size: SIZE.small,
        color: COLOR.muted,
      });
      this.y += captionHeight;
    }
    this.y += 10;
  }

  /** The header and footer of every page, once the page count is known. */
  private pageLines() {
    const { header, footer } = this.layout;
    if (!header && !footer) return;
    const range = this.doc.bufferedPageRange();
    const style = { size: SIZE.small, color: COLOR.muted };
    const half = this.width / 2 - 8;
    const margin = this.layout.page.margin;
    for (let i = 0; i < range.count; i++) {
      this.doc.switchToPage(range.start + i);
      const page = this.doc.page;
      const put = (text: string | undefined, top: number, align: Align) => {
        if (!text) return;
        const [line] = this.wrap(pageText(text, i + 1, range.count), half, style);
        if (!line) return;
        const x = align === 'left' ? this.left : this.left + this.width - half;
        this.drawLine(line, x, top, half, align, style);
      };
      const head = this.pageImageBox('header');
      const foot = this.pageImageBox('footer');
      // Beside an image, the text is centred on it; otherwise where it always was.
      const headTop = head ? head.y + head.height / 2 - 5 : Math.max(margin / 2 - 6, 8);
      const footTop = foot
        ? foot.y + foot.height / 2 - 5
        : page.height - Math.max(margin / 2 + 4, 18);
      const line = (
        l: NonNullable<CheckedLayout['header']>,
        top: number,
        box: { y: number; height: number } | undefined,
      ) => {
        const image = l.image;
        if (image && box) {
          const { width, height } = this.shape(image.image);
          const w = Math.min((width / height) * box.height, half);
          const x = image.side === 'left' ? this.left : this.left + this.width - w;
          this.drawImage(image.image, x, box.y, w, box.height);
        }
        if (image?.side !== 'left') put(l.left, top, 'left');
        if (image?.side !== 'right') put(l.right, top, 'right');
      };
      if (header) line(header, headTop, head);
      if (footer) line(footer, footTop, foot);
    }
  }

  async write(): Promise<Rendered> {
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      this.doc.on('data', (c: Buffer) => chunks.push(c));
      this.doc.on('end', () => resolve(Buffer.concat(chunks)));
      this.doc.on('error', reject);
    });
    for (const b of this.layout.blocks) {
      switch (b.type) {
        case 'heading':
          this.heading(b);
          break;
        case 'text':
          this.text(
            b.text,
            { size: b.size ?? SIZE.text, bold: b.bold, color: b.muted ? COLOR.muted : COLOR.text },
            b.align ?? 'left',
            (b.size ?? SIZE.text) * 0.4,
          );
          break;
        case 'fields':
          this.fields(b);
          break;
        case 'table':
          this.table(b);
          break;
        case 'totals':
          this.totals(b);
          break;
        case 'spacer':
          this.y += b.size;
          if (this.y > this.bottom) this.newPage();
          break;
        case 'rule':
          this.ensure(8);
          this.rule(this.y + 4);
          this.y += 8;
          break;
        case 'pageBreak':
          if (this.y > this.top) this.newPage();
          break;
        case 'image':
          this.image(b);
          break;
        case 'images':
          this.images(b);
          break;
        case 'qr':
          this.qr(b);
          break;
      }
    }
    this.pageLines();
    const pages = this.doc.bufferedPageRange().count;
    this.doc.end();
    return { bytes: await done, pages };
  }
}

/**
 * The PDF engine: pdfkit writes the file, HarfBuzz shapes every run, and the Noto fonts (Latin,
 * Devanagari, Telugu; regular and bold) are embedded as subsets. The fonts and HarfBuzz load on
 * the first render, once per process.
 */
export function createPdfEngine(): DocumentEngine {
  return {
    kind: 'pdf',
    mime: 'application/pdf',
    async render(layout, meta) {
      return new PdfWriter(layout, meta, await loadFonts()).write();
    },
  };
}
