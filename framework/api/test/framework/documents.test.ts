// The documents feature's pieces, without booting (B2): the layout model, script runs, HarfBuzz
// shaping of Hindi and Telugu, the real PDF engine (fonts embedded, mapped back to text, pages
// broken and numbered), the fake engine, the configuration and defineDocument's checks.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { defineTemplate } from '@hykr/notifications';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertDocumentsConfig, documentsConfig } from '../../dist/features/documents/config.js';
import { defineDocument, pdfName } from '../../dist/features/documents/define.js';
import {
  createFakeEngine,
  createPdfEngine,
  fontFile,
  harfbuzz,
  loadFonts,
  scriptRuns,
  shaperFor,
} from '../../dist/features/documents/engine/index.js';
import { DocumentLayout, layoutLines, pageText } from '../../dist/features/documents/layout.js';

const meta = {
  lang: 'en' as const,
  author: 'A business',
  createdAt: new Date('2026-01-02T03:04:05Z'),
};

/** Every stream in a PDF, inflated when it is compressed: what its pages and maps say. */
function streams(pdf: Buffer): string {
  const text = pdf.toString('latin1');
  const out: string[] = [];
  for (const m of text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const raw = Buffer.from(m[1], 'latin1');
    try {
      out.push(inflateSync(raw).toString('latin1'));
    } catch {
      out.push(m[1]);
    }
  }
  return out.join('\n');
}

describe('the layout', () => {
  it('fills defaults, and refuses a row that does not fit its table', () => {
    const ok = DocumentLayout.parse({ title: 'T', blocks: [{ type: 'heading', text: 'H' }] });
    expect(ok.page).toEqual({ size: 'A4', margin: 48 });
    expect(ok.blocks[0]).toEqual({ type: 'heading', text: 'H', level: 1 });
    const bad = DocumentLayout.safeParse({
      title: 'T',
      blocks: [
        { type: 'table', columns: [{ label: 'A' }, { label: 'B' }], rows: [{ cells: ['x'] }] },
      ],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('1 cells; the table has 2 columns');
    expect(DocumentLayout.safeParse({ title: '', blocks: [] }).success).toBe(false);
    expect(DocumentLayout.safeParse({ title: 'T', blocks: [{ type: 'image' }] }).success).toBe(
      false,
    );
  });

  it('reads as lines, in order; page numbers fill in', () => {
    const lines = layoutLines(
      DocumentLayout.parse({
        title: 'T',
        header: { left: 'Left', right: 'Right' },
        footer: { right: 'Page {page} of {pages}' },
        blocks: [
          { type: 'heading', text: 'Heading' },
          { type: 'fields', items: [{ label: 'Number', value: 'A-1' }] },
          {
            type: 'table',
            columns: [{ label: 'Item' }, { label: 'Qty' }],
            rows: [
              { cells: ['Group', ''], kind: 'group' },
              { cells: ['Line', '2'], indent: 1 },
            ],
          },
          { type: 'totals', rows: [{ label: 'Total', value: '2' }] },
        ],
      }),
    );
    expect(lines).toEqual([
      'Left  Right',
      'Heading',
      'Number: A-1',
      'Item | Qty',
      'Group | ',
      '  Line | 2',
      'Total: 2',
      'Page {page} of {pages}',
    ]);
    expect(pageText('Page {page} of {pages}', 2, 3)).toBe('Page 2 of 3');
  });
});

describe('text in Latin, Devanagari and Telugu', () => {
  it('splits into one run per script; shared characters stay with their run', () => {
    expect(scriptRuns('Order क्ष 12, తెలుగు!')).toEqual([
      { script: 'latin', text: 'Order ' },
      { script: 'deva', text: 'क्ष 12, ' },
      { script: 'telu', text: 'తెలుగు!' },
    ]);
    // Leading digits take the script after them; a font without a glyph hands it on.
    expect(scriptRuns('12 కి')).toEqual([{ script: 'telu', text: '12 కి' }]);
    expect(scriptRuns('हि €5', (s, cp) => !(s === 'deva' && cp === 0x20ac))).toEqual([
      { script: 'deva', text: 'हि ' },
      { script: 'latin', text: '€' },
      { script: 'deva', text: '5' },
    ]);
    expect(scriptRuns('')).toEqual([]);
  });

  it('HarfBuzz shapes conjuncts and reordering: fewer glyphs than letters, none missing', async () => {
    const hb = await harfbuzz();
    const deva = shaperFor(hb, readFileSync(fontFile('deva', false)));
    const telu = shaperFor(hb, readFileSync(fontFile('telu', false)));
    for (const word of ['क्ष', 'श्री', 'प्रेम', 'अर्द्ध', 'कृष्ण']) {
      const glyphs = deva(word);
      expect(glyphs.length, word).toBeLessThan([...word].length);
      expect(
        glyphs.every((g) => g.glyph !== 0),
        word,
      ).toBe(true);
    }
    for (const word of ['శ్రీ', 'ప్రేమ', 'కృష్ణ', 'క్ష', 'స్త్రీ']) {
      const glyphs = telu(word);
      expect(glyphs.length, word).toBeLessThan([...word].length);
      expect(
        glyphs.every((g) => g.glyph !== 0),
        word,
      ).toBe(true);
    }
    // कि: the vowel sign i (one of the font's widths of it) is drawn before its consonant.
    const fonts = await loadFonts();
    const fk = fonts.get('deva')?.font as unknown as {
      glyphForCodePoint(cp: number): { id: number };
    };
    const ki = deva('कि');
    expect(ki).toHaveLength(2);
    expect(ki[1].glyph).toBe(fk.glyphForCodePoint(0x0915).id);
    expect(ki[0].glyph).not.toBe(ki[1].glyph);
    expect(ki.every((g) => g.cluster === 0)).toBe(true);
  });

  it('fontkit lays text out with HarfBuzz, and keeps each glyph’s text for copying', async () => {
    const fonts = await loadFonts();
    const telu = fonts.get('telu')?.font;
    if (!telu) throw new Error('no Telugu font');
    // fontkit's own shaping throws on this word with Noto Sans Telugu (decisions F6, 22).
    const run = telu.layout('శ్రీ ప్రేమ');
    expect(run.glyphs.length).toBeGreaterThan(0);
    expect(run.advanceWidth).toBeGreaterThan(0);
    expect(run.glyphs.flatMap((g) => g.codePoints)).toContain(0x0c36);
  });
});

describe('the PDF engine', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    cells: [`Line ${i + 1} कैबिनेट / క్యాబినెట్`, String(i + 1), `${(i + 1) * 15}.00`],
    indent: 1,
  }));
  const layout = DocumentLayout.parse({
    title: 'A long document',
    header: { left: 'A business', right: 'A-0001' },
    footer: { right: 'Page {page} of {pages}' },
    blocks: [
      { type: 'heading', text: 'A-0001 — हिन्दी — తెలుగు' },
      {
        type: 'fields',
        items: [
          { label: 'तारीख', value: '6 नवंबर 2026' },
          { label: 'స్థితి', value: 'తెరిచి ఉంది' },
        ],
      },
      { type: 'text', text: 'हिन्दी किताब क्षत्रिय श्री प्रेम अर्द्ध स्त्री', bold: true },
      { type: 'text', text: 'తెలుగు క్ష శ్రీ స్త్రీ కృష్ణ ప్రేమ', align: 'right' },
      {
        type: 'table',
        columns: [
          { label: 'Item', width: 4 },
          { label: 'Qty', align: 'right' },
          { label: 'Amount', width: 1.5, align: 'right' },
        ],
        rows: [
          { cells: ['Group', '', '1,815.00'], kind: 'group' },
          ...rows,
          { cells: ['Sum', '', '1,815.00'], kind: 'subtotal' },
        ],
      },
      { type: 'totals', rows: [{ label: 'Total', value: '1,815.00', strong: true }] },
      { type: 'rule' },
      { type: 'spacer', size: 20 },
      { type: 'text', text: 'Thank you.', muted: true, align: 'center' },
    ],
  });

  it('writes a valid PDF: the three scripts embedded, mapped back to their text', async () => {
    const { bytes, pages } = await createPdfEngine().render(layout, { ...meta, lang: 'hi' });
    const text = bytes.toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    for (const font of [
      'NotoSans-Regular',
      'NotoSans-Bold',
      'NotoSansDevanagari',
      'NotoSansTelugu',
    ])
      expect(text, font).toMatch(new RegExp(`/BaseFont /[A-Z]{6}\\+${font}`));
    expect((text.match(/\/ToUnicode/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // The fonts are subsets, mapped back to the letters they draw (copy and search work).
    const maps = streams(bytes).toLowerCase();
    expect(maps).toContain('begincmap');
    // क, ष, శ, ర and A: each drawn glyph names the letters it stands for.
    for (const cp of ['0915', '0937', '0c36', '0c30', '0041']) expect(maps).toContain(cp);
    // A long table breaks onto more pages, each counted in the page tree.
    expect(pages).toBeGreaterThan(2);
    expect(text).toContain(`/Count ${pages}`);
    expect(text).toMatch(/\/Title \d+ 0 R/);
    expect(text).toContain('(A long document)');
    expect(text).toMatch(/\/Lang \(hi\)/);
  }, 30_000);

  it('the fake engine writes the layout’s lines as a small PDF, a page per break', async () => {
    const out = await createFakeEngine().render(
      DocumentLayout.parse({
        title: 'Fake (one)',
        blocks: [
          { type: 'heading', text: 'Hello (world) \\ हिन्दी' },
          { type: 'pageBreak' },
          { type: 'text', text: 'Second' },
        ],
      }),
      meta,
    );
    const text = out.bytes.toString('utf8');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('(Hello \\(world\\) \\\\ हिन्दी) Tj');
    expect(text).toContain('(Second) Tj');
    expect(text).toContain('/Title (Fake \\(one\\))');
    expect(out.pages).toBe(2);
    // The cross-reference table points at each object.
    const xref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(out.bytes.subarray(xref, xref + 4).toString()).toBe('xref');
  });
});

describe('configuration and definitions', () => {
  it('DOCUMENTS_ENGINE: pdf by default, fake for tests, nothing else; production refuses fake', () => {
    expect(documentsConfig({})).toEqual({ engine: 'pdf' });
    expect(documentsConfig({ DOCUMENTS_ENGINE: 'FAKE' })).toEqual({ engine: 'fake' });
    expect(() => documentsConfig({ DOCUMENTS_ENGINE: 'chrome' })).toThrow(/pdf or fake/);
    expect(() => assertDocumentsConfig({ engine: 'fake' }, { NODE_ENV: 'production' })).toThrow(
      /production/,
    );
    expect(() =>
      assertDocumentsConfig({ engine: 'pdf' }, { NODE_ENV: 'production' }),
    ).not.toThrow();
  });

  it('defineDocument refuses a bad name, a template without a document header, an empty channel', () => {
    const base = {
      name: 'things.thing',
      label: { en: 'Thing', hi: 'Thing', te: 'Thing' },
      entity: 'thing',
      load: () => ({}),
      render: () => ({ title: 'T', blocks: [] }),
      fileName: () => 't',
    };
    expect(defineDocument(base).name).toBe('things.thing');
    expect(() => defineDocument({ ...base, name: 'Thing' })).toThrow(/<owner>\.<kind>/);
    const plain = defineTemplate({
      name: 'thing_plain_v1',
      category: 'utility',
      params: z.object({ a: z.string() }),
      body: { en: '{{a}}', hi: '{{a}}', te: '{{a}}' },
      example: { a: 'x' },
    });
    expect(() =>
      defineDocument({
        ...base,
        send: { whatsapp: { template: plain, params: () => ({ a: 'x' }) } },
      }),
    ).toThrow(/no document header/);
    expect(() => defineDocument({ ...base, send: { order: ['email'] } })).toThrow(/says nothing/);
  });

  it('file names end in .pdf and never hold a path', () => {
    expect(pdfName('A/2026\\07')).toBe('A-2026-07.pdf');
    expect(pdfName('x.PDF')).toBe('x.PDF');
    expect(pdfName('  ')).toBe('document.pdf');
    expect(pdfName('a\nb')).toBe('a-b.pdf');
  });
});
