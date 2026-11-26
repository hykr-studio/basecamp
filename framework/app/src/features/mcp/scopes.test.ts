import { t } from '@hykr/i18n';
import { describe, expect, it } from 'vitest';
import { scopeWords } from './scopes';

const en = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
  t('en', key, vars);

describe('a connected AI app’s scopes, in words', () => {
  it('names each module once, change covering read, and staying connected', () => {
    expect(
      scopeWords(['orders:read', 'orders:write', 'todos:read', 'offline_access', 'other'], en),
    ).toEqual(['orders: Change', 'todos: Read', 'Stays connected']);
    expect(scopeWords(['todos:write', 'todos:read'], en)).toEqual(['todos: Change']);
    expect(scopeWords([], en)).toEqual([]);
  });
});
