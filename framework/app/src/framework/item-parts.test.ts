import { describe, expect, it } from 'vitest';
import { childLabels, labelledParts } from './item-parts';

const specs = [
  { fieldLabels: { title: { en: 'Name' } } },
  {
    traits: { parent: { entity: 'basket' } },
    fieldLabels: {
      title: { en: 'Item', hi: 'आइटम' },
      count: { en: 'Count', hi: 'गिनती' },
      price: { en: 'Price' },
      note: { en: 'Note' },
    },
  },
  { traits: { parent: { entity: 'other' } }, fieldLabels: { weight: { en: 'Weight' } } },
];

describe("an approval's list of lines (preview)", () => {
  it("takes the labels of the entities under the record's", () => {
    const labels = childLabels(specs, 'basket');
    expect(Object.keys(labels).sort()).toEqual(['count', 'note', 'price', 'title']);
    expect(childLabels(specs, undefined)).toEqual({});
    expect(childLabels(specs, 'nothing')).toEqual({});
  });

  it('shows the fields the module named, in its words, and nothing else', () => {
    const labels = childLabels(specs, 'basket');
    const item = { ref: 'a1', kind: 'line', title: 'Chair', count: 2, price: '1500.00', note: '' };
    expect(labelledParts(item, labels, 'en', new Set(['title']))).toEqual([
      'Count 2',
      'Price 1500.00',
    ]);
    expect(labelledParts({ count: 3 }, labels, 'hi', new Set())).toEqual(['गिनती 3']);
    // A long text or an object is not a line's detail.
    expect(
      labelledParts({ note: 'x'.repeat(41), price: { a: 1 } }, labels, 'en', new Set()),
    ).toEqual([]);
  });
});
