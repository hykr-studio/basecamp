import { describe, expect, it } from 'vitest';
import { brandTokens, hideOff, mix, themeSignature } from './tokens';

describe("a business's look and words, as a key", () => {
  const none = { primary: null, primaryText: null, rail: null };

  it("is the product's when they change nothing, so the app is not remounted", () => {
    expect(themeSignature(none, {})).toBe('product');
    expect(themeSignature(null, null)).toBe('product');
    expect(themeSignature(undefined, undefined)).toBe('product');
  });

  it('changes with a colour or a phrase of its own, and only then', () => {
    const blue = themeSignature({ ...none, primary: '#204080' }, {});
    expect(blue).not.toBe('product');
    expect(themeSignature({ ...none, primary: '#204080' }, {})).toBe(blue);
    expect(themeSignature({ ...none, primary: '#204081' }, {})).not.toBe(blue);
    const worded = themeSignature(none, { 'chat.placeholder': { en: 'Ask us' } });
    expect(worded).not.toBe('product');
    expect(worded).not.toBe(blue);
  });
});

describe('brand tokens (A11)', () => {
  it('a primary colour sets its hover and tint; unset colours keep the theme', () => {
    const { tokens, cssVars } = brandTokens({ primary: '#204080', primaryText: null, rail: null });
    expect(tokens).toEqual({
      primary: '#204080',
      primaryHover: mix('#204080', '#000000', 0.15),
      primaryTint: mix('#204080', '#ffffff', 0.9),
    });
    expect(cssVars['--color-primary']).toBe('#204080');
    expect(brandTokens(null).tokens).toEqual({});
  });

  it('mixes towards another colour', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#102030', '#102030', 0.3)).toBe('#102030');
  });
});

describe('navigation without what is switched off', () => {
  const items = [
    { href: '/todos', module: 'todos' },
    { href: '/notes', module: 'notes' },
    { href: '/notes/board', module: 'notes' },
    { href: '/' },
  ];

  it("hides a switched-off module's destinations and gated hrefs", () => {
    expect(
      hideOff(items, { modules: ['todos'], nav: ['/notes/board'] }).map((i) => i.href),
    ).toEqual(['/notes', '/']);
    expect(hideOff(items, null)).toHaveLength(4);
  });
});
