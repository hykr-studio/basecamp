import { describe, expect, it } from 'vitest';
import { defineMessages, mergeMessages } from './messages/define.js';
import * as parts from './messages/index.js';
import { catalogs, t } from './messages.js';

describe('message parts', () => {
  it('each translation the framework ships has every key of its part, and no other', () => {
    for (const [name, part] of Object.entries(parts)) {
      const keys = Object.keys(part.en).sort();
      for (const [lang, phrases] of Object.entries(part))
        expect(Object.keys(phrases ?? {}).sort(), `${name}.${lang}`).toEqual(keys);
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

  it('merging two parts with one key throws; a partial translation merges', () => {
    const a = defineMessages({
      en: { 'x.same': 'A', 'x.other': 'O' },
      hi: { 'x.same': 'अ' },
      te: { 'x.same': 'అ', 'x.other': 'ఒ' },
    });
    const b = defineMessages({ en: { 'x.same': 'B' } });
    expect(() => mergeMessages([a, b])).toThrow(/x\.same/);
    const merged = mergeMessages([a]);
    expect(merged.te['x.same']).toBe('అ');
    expect(merged.hi['x.other']).toBeUndefined();
  });
});
