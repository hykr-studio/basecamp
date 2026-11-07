import PDFDocument from 'pdfkit';
import { type Align, type CheckedLayout, pageText } from '../layout.js';
import type { DocumentEngine, Rendered, RenderMeta } from './engine.js';
import { fontName, type LoadedFont, loadFonts, type Script, scriptRuns } from './fonts.js';

/** Neutral colours: the application's branding is not the framework's. */
const COLOR = { text: '#111827', muted: '#6b7280', rule: '#d1d5db', fill: '#f3f4f6' };
const SIZE = { text: 10, small: 8, table: 9, h1: 18, h2: 14, h3: 11.5 };
const HEADING = { 1: SIZE.h1, 2: SIZE.h2, 3: SIZE.h3 } as const;
const PAD = { x: 4, y: 3 };
/** How far one level of a table row's indent moves its first cell. */
const INDENT = 10;

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

  constructor(
    private readonly layout: CheckedLayout,
    meta: RenderMeta,
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
    this.top = page.margins.top;
    this.bottom = page.height - page.margins.bottom;
    this.y = this.top;
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
      const headTop = Math.max(margin / 2 - 6, 8);
      const footTop = page.height - Math.max(margin / 2 + 4, 18);
      put(header?.left, headTop, 'left');
      put(header?.right, headTop, 'right');
      put(footer?.left, footTop, 'left');
      put(footer?.right, footTop, 'right');
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
