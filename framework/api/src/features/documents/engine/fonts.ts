import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

/**
 * The fonts documents are set in, and how their text is shaped. pdfkit embeds fontkit fonts but
 * fontkit's own shaping fails on common Telugu words (docs/decisions/F6.md, 22), so each font's
 * `layout` is replaced by HarfBuzz's: fontkit then only parses, subsets and embeds. pdfkit does no
 * font fallback, so text is split into runs by script, each set in its own Noto font.
 */

const require = createRequire(import.meta.url);

/** The scripts documents are set in: Latin (and everything else Noto Sans has), Devanagari, Telugu. */
export type Script = 'latin' | 'deva' | 'telu';
export const SCRIPTS: readonly Script[] = ['latin', 'deva', 'telu'];

const FAMILIES: Record<Script, { pkg: string; family: string }> = {
  latin: { pkg: 'noto-sans', family: 'NotoSans' },
  deva: { pkg: 'noto-sans-devanagari', family: 'NotoSansDevanagari' },
  telu: { pkg: 'noto-sans-telugu', family: 'NotoSansTelugu' },
};

/** A font file, regular or bold, from the @expo-google-fonts packages (OFL). */
export function fontFile(script: Script, bold: boolean): string {
  const { pkg, family } = FAMILIES[script];
  const weight = bold ? '700Bold' : '400Regular';
  return require.resolve(`@expo-google-fonts/${pkg}/${weight}/${family}_${weight}.ttf`);
}

/** The font a run is set in, by script and weight: 'deva-bold'. */
export const fontName = (script: Script, bold: boolean) => `${script}${bold ? '-bold' : ''}`;

const TELUGU = /[ఀ-౿]/u;
const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ᳐-᳿]/u;
const LETTER = /[\p{L}\p{M}]/u;

/** A character's script; undefined for one every script shares (spaces, digits, punctuation). */
export function scriptOfChar(ch: string): Script | undefined {
  if (TELUGU.test(ch)) return 'telu';
  if (DEVANAGARI.test(ch)) return 'deva';
  if (LETTER.test(ch)) return 'latin';
  return undefined;
}

export interface Run {
  script: Script;
  text: string;
}

/**
 * The text as runs of one script each. A shared character (a space, a digit, a comma, a joiner)
 * stays with the run it is in (the one before it, or after it at the start), so a word and its
 * punctuation shape together; a character that run's font lacks goes to a font that has it.
 */
export function scriptRuns(
  text: string,
  has: (script: Script, codePoint: number) => boolean = () => true,
): Run[] {
  const chars = [...text];
  const own = chars.map(scriptOfChar);
  const scripts: (Script | undefined)[] = [];
  let before: Script | undefined;
  for (const [i, s] of own.entries()) {
    if (s) before = s;
    scripts[i] = s ?? before;
  }
  let after: Script | undefined;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (own[i]) after = own[i];
    scripts[i] ??= after ?? 'latin';
  }
  const runs: Run[] = [];
  for (const [i, ch] of chars.entries()) {
    let script = scripts[i] as Script;
    const cp = ch.codePointAt(0) ?? 0;
    if (!has(script, cp)) script = SCRIPTS.find((s) => has(s, cp)) ?? script;
    const last = runs.at(-1);
    if (last?.script === script) last.text += ch;
    else runs.push({ script, text: ch });
  }
  return runs;
}

/* ── HarfBuzz ──────────────────────────────────────────────────────────────── */

type HarfBuzz = typeof import('harfbuzzjs');
let hbLoading: Promise<HarfBuzz> | undefined;

/** HarfBuzz (WASM), loaded once, when the first document is drawn. */
export function harfbuzz(): Promise<HarfBuzz> {
  hbLoading ??= import('harfbuzzjs').catch((e) => {
    hbLoading = undefined;
    throw e;
  });
  return hbLoading;
}

/** One shaped glyph: its id in the font, the text it stands for, and where it goes. */
export interface Shaped {
  glyph: number;
  /** UTF-16 offset of its cluster in the text. */
  cluster: number;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}

/** A shaper for one font file: the text's glyphs and positions, in font units. */
export function shaperFor(hb: HarfBuzz, data: Uint8Array): (text: string) => Shaped[] {
  const font = new hb.Font(new hb.Face(new hb.Blob(data), 0));
  return (text) => {
    const buffer = new hb.Buffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    hb.shape(font, buffer);
    return buffer.getGlyphInfosAndPositions().map((g) => ({
      glyph: g.codepoint,
      cluster: g.cluster,
      xAdvance: g.xAdvance ?? 0,
      yAdvance: g.yAdvance ?? 0,
      xOffset: g.xOffset ?? 0,
      yOffset: g.yOffset ?? 0,
    }));
  };
}

/* ── Fonts as pdfkit embeds them ───────────────────────────────────────────── */

/** What pdfkit uses of a fontkit font (pdfkit's own dependency, not ours to import). */
interface FontkitGlyph {
  id: number;
  codePoints: number[];
  advanceWidth: number;
}
export interface FontkitFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  hasGlyphForCodePoint(codePoint: number): boolean;
  getGlyph(id: number, codePoints?: number[]): FontkitGlyph;
  layout(text: string): {
    glyphs: FontkitGlyph[];
    positions: { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }[];
    advanceWidth: number;
  };
}

export interface LoadedFont {
  name: string;
  script: Script;
  bold: boolean;
  font: FontkitFont;
  /** Above and below the baseline, per 1000 units of size. */
  ascent: number;
  descent: number;
}

/** Replace a fontkit font's layout with HarfBuzz's. */
function shapeWithHarfBuzz(font: FontkitFont, shape: (text: string) => Shaped[]) {
  font.layout = (text: string) => {
    const shaped = shape(text);
    // Clusters are UTF-16 offsets: each glyph stands for its cluster's code points.
    const starts = [...new Set(shaped.map((g) => g.cluster))].sort((a, b) => a - b);
    const glyphs = shaped.map((g) => {
      const end = starts.find((s) => s > g.cluster) ?? text.length;
      const codePoints = [...text.slice(g.cluster, end)].map((c) => c.codePointAt(0) ?? 0);
      return font.getGlyph(g.glyph, codePoints);
    });
    const positions = shaped.map(({ xAdvance, yAdvance, xOffset, yOffset }) => ({
      xAdvance,
      yAdvance,
      xOffset,
      yOffset,
    }));
    return { glyphs, positions, advanceWidth: shaped.reduce((w, g) => w + g.xAdvance, 0) };
  };
}

let fontsLoading: Promise<ReadonlyMap<string, LoadedFont>> | undefined;

/**
 * The six fonts (three scripts, regular and bold), parsed once per process and shaped with
 * HarfBuzz. pdfkit parses each file into a fontkit font; every document then embeds those
 * fontkit fonts (subset to the glyphs it uses).
 */
export function loadFonts(): Promise<ReadonlyMap<string, LoadedFont>> {
  fontsLoading ??= (async () => {
    const hb = await harfbuzz();
    const probe = new PDFDocument({ autoFirstPage: false });
    const fonts = new Map<string, LoadedFont>();
    for (const script of SCRIPTS)
      for (const bold of [false, true]) {
        const name = fontName(script, bold);
        const data = readFileSync(fontFile(script, bold));
        probe.registerFont(name, data);
        probe.font(name);
        const font = (probe as unknown as { _font: { font: FontkitFont } })._font.font;
        shapeWithHarfBuzz(font, shaperFor(hb, data));
        const scale = 1000 / font.unitsPerEm;
        fonts.set(name, {
          name,
          script,
          bold,
          font,
          ascent: font.ascent * scale,
          descent: -font.descent * scale,
        });
      }
    return fonts;
  })().catch((e) => {
    fontsLoading = undefined;
    throw e;
  });
  return fontsLoading;
}
