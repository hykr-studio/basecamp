// The telephony providers an application contributes. Nothing here reads the configuration or
// loads Nest: safe to import from an application module at load time.
import type { TelephonyProvider } from '@hykr/connectors';
import { createHookRegistry, reserveRoutes } from '@hykr/contracts';

declare module '@hykr/contracts' {
  interface Contributions {
    // biome-ignore lint/suspicious/noExplicitAny: each provider has its own credentials
    telephonyProviders: readonly TelephonyProvider<any>[];
  }
}

// /api/calls is the calls feature's: no module may serve a route under it.
reserveRoutes('calls');

/**
 * The services that connect calls, by name, in the order a business tries them. None ships with
 * the framework; an application adds its own (`defineTelephonyProvider`).
 */
// biome-ignore lint/suspicious/noExplicitAny: each provider has its own credentials
export const telephonyProviders = createHookRegistry<TelephonyProvider<any>>(
  'telephony provider',
  (p) => p.name,
  { collects: 'telephonyProviders' },
);
