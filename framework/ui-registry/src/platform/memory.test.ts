import { describe, expect, it } from 'vitest';
import { MemoryListView } from './memory.js';

const memory = (text: string) => ({
  id: text,
  text,
  createdBy: 'person' as const,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
});

describe('memory.list', () => {
  const ctx = { timeZone: 'UTC', lang: 'en' as const };

  it('lists the business’s memories in words, cut short', () => {
    const items = [memory('Closed on Sundays'), memory('x'.repeat(200))];
    const text = MemoryListView.text({ items }, ctx);
    expect(text.split('\n')[0]).toBe('What the business remembers');
    expect(text).toContain('• Closed on Sundays');
    expect(text.split('\n')[2].length).toBeLessThanOrEqual(162);
  });

  it('says when there is nothing, in the person’s language', () => {
    expect(MemoryListView.text({ items: [] }, ctx)).toBe('Nothing remembered yet.');
    expect(MemoryListView.speak({ items: [] }, { ...ctx, lang: 'hi' })).toBe(
      'अभी कुछ याद नहीं रखा गया है।',
    );
  });

  it('speaks a count and the first few', () => {
    expect(MemoryListView.speak({ items: [memory('Closed on Sundays')] }, ctx)).toContain(
      'Closed on Sundays',
    );
  });
});
