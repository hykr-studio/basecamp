import { parseScope } from '@hykr/contracts';
import type { MessageKey } from '@hykr/i18n';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/**
 * What a connection may do, in the person's words: each module once, read or change (change
 * covers read), and whether it stays connected. Scopes the app does not know are left out.
 */
export function scopeWords(scopes: readonly string[], t: T): string[] {
  const access = new Map<string, 'read' | 'write'>();
  for (const s of scopes) {
    const parsed = parseScope(s);
    if (!parsed) continue;
    if (parsed.access === 'write' || !access.has(parsed.module))
      access.set(parsed.module, parsed.access);
  }
  const words = [...access].map(
    ([module, a]) => `${module}: ${t(a === 'write' ? 'mcp.consent.write' : 'mcp.consent.read')}`,
  );
  if (scopes.includes('offline_access')) words.push(t('mcp.connections.offline'));
  return words;
}
