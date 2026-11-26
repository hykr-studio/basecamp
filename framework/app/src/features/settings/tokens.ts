// A business's colours as the app's tokens (A11): what the theme provider sets, both as the
// StyleSheet values in theme.ts and as the Tailwind variables in theme.css. Pure, so it is tested
// without React Native.

/** The colours a business may set (the `branding` settings section). */
export type BrandColors = {
  primary: string | null;
  primaryText: string | null;
  rail: string | null;
};

const hex = (c: string) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16));
const toHex = (rgb: number[]) =>
  `#${rgb
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** `color` moved towards `to` by `amount` (0 to 1). */
export const mix = (color: string, to: string, amount: number) => {
  const [a, b] = [hex(color), hex(to)];
  return toHex(a.map((v, i) => v + (b[i] - v) * amount));
};

/** theme.ts token → theme.css variable. */
const CSS_VAR: Record<string, string> = {
  primary: '--color-primary',
  primaryHover: '--color-primary-hover',
  primaryTint: '--color-primary-tint',
  primaryText: '--color-primary-text',
  rail: '--color-rail',
  railHover: '--color-rail-hover',
};

/**
 * The tokens a business's colours replace, with the shades the theme derives from them (a hover
 * a step darker, a tint near white). Colours it did not set are left out: the theme's stay.
 */
export function brandTokens(colors: BrandColors | null | undefined): {
  tokens: Record<string, string>;
  cssVars: Record<string, string>;
} {
  const tokens: Record<string, string> = {};
  if (colors?.primary) {
    tokens.primary = colors.primary;
    tokens.primaryHover = mix(colors.primary, '#000000', 0.15);
    tokens.primaryTint = mix(colors.primary, '#ffffff', 0.9);
  }
  if (colors?.primaryText) tokens.primaryText = colors.primaryText;
  if (colors?.rail) {
    tokens.rail = colors.rail;
    tokens.railHover = mix(colors.rail, '#000000', 0.05);
  }
  const cssVars = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [CSS_VAR[k], v]));
  return { tokens, cssVars };
}

/**
 * What a business's settings change in how the app looks and speaks, as a key that changes only
 * when that does: `'product'` when they change nothing (no colour of its own, no phrase). The
 * settings provider remounts the app on a new key, so a business that changes nothing never
 * costs a remount.
 */
export function themeSignature(
  colors: BrandColors | null | undefined,
  phrases: Readonly<Record<string, unknown>> | null | undefined,
): string {
  const { tokens } = brandTokens(colors);
  const words = phrases && Object.keys(phrases).length > 0 ? phrases : null;
  if (Object.keys(tokens).length === 0 && !words) return 'product';
  return JSON.stringify([tokens, words]);
}

/** What a business switched off, as the app's navigation needs it. */
export type Off = { modules: readonly string[]; nav: readonly string[] };

/** Destinations without the ones a switched-off flag gates (their module, or their href). */
export function hideOff<T extends { href: string; module?: string }>(
  items: readonly T[],
  off: Off | null | undefined,
): T[] {
  if (!off) return [...items];
  return items.filter(
    (i) => !(i.module && off.modules.includes(i.module)) && !off.nav.includes(i.href),
  );
}
