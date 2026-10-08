import { type Labels, type Lang, langOf, type MessageKey, pick, t } from '@app/i18n';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

type LangState = { lang: Lang; setSpoken: (lang: Lang | undefined) => void };
const LangContext = createContext<LangState>({ lang: 'en', setSpoken: () => {} });

/** The device's language, if the product speaks it. */
const deviceLang = (): Lang => langOf(Intl.DateTimeFormat().resolvedOptions().locale);

/**
 * The language the app shows its words in: the voice session's while one runs (so the
 * screen and the voice agree), the device's otherwise. The app's own screen copy stays in
 * English; views, approval cards, system lines and the voice controls follow this.
 */
export function LangProvider({ children }: { children: ReactNode }) {
  const [spoken, setSpoken] = useState<Lang | undefined>();
  const value = useMemo(() => ({ lang: spoken ?? deviceLang(), setSpoken }), [spoken]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export const useLang = () => useContext(LangContext);

/** Words in the current language: the framework's phrases (t) and a domain's Labels (pick). */
export function useT() {
  const { lang } = useLang();
  return useMemo(
    () => ({
      lang,
      t: (key: MessageKey, vars?: Record<string, string | number>) => t(lang, key, vars),
      pick: (labels: Labels) => pick(labels, lang),
    }),
    [lang],
  );
}
