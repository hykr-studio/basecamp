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
]);
export type DocumentBlock = z.input<typeof DocumentBlock>;

/** A line at the top or bottom of every page. `{page}` and `{pages}` are filled in. */
const PageLine = z.object({ left: Text.optional(), right: Text.optional() });

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

/** `{page}` and `{pages}` in a header or footer line. */
export const pageText = (text: string, page: number, pages: number) =>
  text.replaceAll('{page}', String(page)).replaceAll('{pages}', String(pages));

/**
 * The layout's words as lines, in reading order: what the fake engine writes, and what tests
 * and the assistant can check a document says.
 */
export function layoutLines(layout: CheckedLayout): string[] {
  const out: string[] = [];
  const pair = (l?: string, r?: string) => [l, r].filter(Boolean).join('  ');
  if (layout.header) out.push(pair(layout.header.left, layout.header.right));
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
      case 'spacer':
      case 'rule':
      case 'pageBreak':
        out.push('');
        break;
    }
  }
  if (layout.footer) out.push(pair(layout.footer.left, layout.footer.right));
  return out;
}
