// The calendar services this deployment offers: CALENDAR_PROVIDERS names them (default
// `google`), and each is offered once its OAuth client is set (decisions B22).
import { CalendarProvider } from '@hykr/contracts';
import { ServiceUnavailableException } from '@nestjs/common';
import { googleSettings, microsoftSettings } from '../settings.js';
import { googleProvider } from './google.js';
import { microsoftProvider } from './microsoft.js';
import type { CalendarProviderDef, ProviderName } from './types.js';

export type * from './types.js';

const trimmed = (v: string | undefined) => (v ?? '').trim();

/** The providers the deployment turns on, in its order. Throws on a name it does not know. */
export function enabledProviders(env: NodeJS.ProcessEnv = process.env): ProviderName[] {
  const raw = trimmed(env.CALENDAR_PROVIDERS);
  if (!raw) return ['google'];
  const names: ProviderName[] = [];
  for (const part of raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)) {
    const parsed = CalendarProvider.safeParse(part);
    if (!parsed.success)
      throw new Error(
        `CALENDAR_PROVIDERS names "${part}", which is not a calendar provider (${CalendarProvider.options.join(', ')})`,
      );
    if (!names.includes(parsed.data)) names.push(parsed.data);
  }
  return names;
}

/** A turned-on provider, ready to call; null when it is off or has no OAuth client here. */
export function providerOf(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): CalendarProviderDef | null {
  const parsed = CalendarProvider.safeParse(name);
  if (!parsed.success || !enabledProviders(env).includes(parsed.data)) return null;
  if (parsed.data === 'google') {
    const g = googleSettings(env);
    return g ? googleProvider(g) : null;
  }
  const m = microsoftSettings(env);
  return m ? microsoftProvider(m) : null;
}

/** A provider, or 503 `calendar_provider_unavailable`. */
export function requireProvider(name: string): CalendarProviderDef {
  const p = providerOf(name);
  if (!p) {
    const label = name === 'microsoft' ? 'Microsoft' : name === 'google' ? 'Google' : name;
    throw new ServiceUnavailableException({
      error: 'unavailable',
      rule: 'calendar_provider_unavailable',
      reason: `This server is not set up to connect ${label} calendars`,
    });
  }
  return p;
}
