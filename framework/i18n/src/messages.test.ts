import { describe, expect, it } from 'vitest';
import { LANGS } from './lang.js';
import { defineMessages, mergeMessages } from './messages/define.js';
import * as parts from './messages/index.js';
import { catalogs, t } from './messages.js';

describe('message parts', () => {
  it('each part has the same keys in every language', () => {
    for (const [name, part] of Object.entries(parts)) {
      const keys = Object.keys(part.en).sort();
      for (const lang of LANGS)
        expect(Object.keys(part[lang]).sort(), `${name}.${lang}`).toEqual(keys);
    }
  });

  it('no key is in two parts, and the catalog has every part', () => {
    const all = Object.values(parts).flatMap((part) => Object.keys(part.en));
    expect(new Set(all).size).toBe(all.length);
    expect(Object.keys(catalogs.en).sort()).toEqual([...all].sort());
  });

  it('t() reads a phrase from each part', () => {
    expect(t('en', 'said.onScreen')).toBe("I've put it on screen.");
    expect(t('en', 'approval.approve')).toBe('Approve');
    expect(t('hi', 'voice.talk')).toBe('बोलें');
    expect(t('te', 'channel.choose')).toBe('ఎంచుకోండి');
  });

  it('merging two parts with one key throws', () => {
    const a = defineMessages({
      en: { 'x.same': 'A' },
      hi: { 'x.same': 'अ' },
      te: { 'x.same': 'అ' },
    });
    const b = defineMessages({
      en: { 'x.same': 'B' },
      hi: { 'x.same': 'ब' },
      te: { 'x.same': 'బ' },
    });
    expect(() => mergeMessages([a, b])).toThrow(/x\.same/);
    expect(mergeMessages([a]).te['x.same']).toBe('అ');
  });
});
