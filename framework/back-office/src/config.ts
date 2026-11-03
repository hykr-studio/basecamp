/**
 * Where the back office finds the API. The application passes it in (BackOfficeShell's
 * `config`, or configure()) from its own environment: Expo inlines EXPO_PUBLIC_* variables
 * only in the application's code, so the library never reads process.env itself.
 */
export interface BackOfficeConfig {
  /** The API's address. */
  apiUrl: string;
}

let current: BackOfficeConfig = { apiUrl: 'http://localhost:3000' };

/** Set the configuration, before the first request. Unset fields keep their defaults. */
export function configure(config: Partial<BackOfficeConfig>) {
  const given = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
  current = { ...current, ...given };
}

export const backOfficeConfig = (): BackOfficeConfig => current;
