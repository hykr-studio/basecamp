import { type Languages, setLanguages } from '@hykr/i18n';

/**
 * Where the app finds its services, and the languages it speaks. The application passes these
 * in (AppShell's `config`, or configure()) from its own environment and its own declarations:
 * Expo inlines EXPO_PUBLIC_* variables only in the application's code, not in a library's, so
 * the framework never reads process.env itself.
 */
export interface AppConfig {
  /** The API's address. */
  apiUrl: string;
  /** Mastra Studio, for links from a run to its trace (development only). */
  studioUrl: string;
  /** The app's URL scheme (app.json "scheme"); the native session is stored under it. */
  scheme: string;
  /**
   * The languages the app shows its words in and speaks (`defineLanguages`): the same
   * declaration the server is given. Left out: English alone.
   */
  languages?: Languages;
}

let current: AppConfig = {
  apiUrl: 'http://localhost:3000',
  studioUrl: 'http://localhost:4000',
  scheme: 'app',
};

/** Set the app's configuration, before the first request. Unset fields keep their defaults. */
export function configure(config: Partial<AppConfig>) {
  const given = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
  current = { ...current, ...given };
  if (config.languages) setLanguages(config.languages);
}

/** The current configuration: read it when it is needed, not when a module loads. */
export const appConfig = (): AppConfig => current;
