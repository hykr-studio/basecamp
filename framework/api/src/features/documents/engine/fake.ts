import { type CheckedLayout, layoutLines } from '../layout.js';
import type { DocumentEngine, Rendered, RenderMeta } from './engine.js';

const LINES_PER_PAGE = 60;

/** A PDF literal string: backslashes and parentheses escaped; the words as UTF-8 bytes. */
const literal = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[\r\n]/g, ' ')})`;

/**
 * A minimal, valid, uncompressed PDF of the layout's lines, in Helvetica: fast, and searchable
 * by tests (its words are in the file as UTF-8). It does not shape or wrap anything: tests and
 * CI only. Production refuses it (documentsConfig).
 */
export function createFakeEngine(): DocumentEngine {
  return {
    kind: 'fake',
    mime: 'application/pdf',
    async render(layout: CheckedLayout, meta: RenderMeta): Promise<Rendered> {
      const lines = layoutLines(layout);
      const pages: string[][] = [];
      for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE)
        pages.push(lines.slice(i, i + LINES_PER_PAGE));
      for (const block of layout.blocks) if (block.type === 'pageBreak') pages.push([]);

      // 1 catalog, 2 pages, 3 font, 4 info, then a page and its content per page.
      const objects: string[] = [];
      const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
      objects.push('<< /Type /Catalog /Pages 2 0 R >>');
      objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
      objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
      objects.push(
        `<< /Title ${literal(layout.title)} /Author ${literal(meta.author ?? '')} /Producer (basecamp fake engine) /Lang ${literal(meta.lang)} >>`,
      );
      pages.forEach((page, i) => {
        const text = page.map((l) => `${literal(l)} Tj T*`).join('\n');
        const stream = `BT /F1 10 Tf 14 TL 48 800 Td\n${text}\nET`;
        objects.push(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + i * 2} 0 R >>`,
        );
        objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
      });

      const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
      let at = parts[0].length;
      const offsets: number[] = [];
      objects.forEach((body, i) => {
        offsets.push(at);
        const chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`);
        parts.push(chunk);
        at += chunk.length;
      });
      const xref =
        `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${at}\n%%EOF\n`;
      parts.push(Buffer.from(xref));
      return { bytes: Buffer.concat(parts), pages: pages.length };
    },
  };
}
