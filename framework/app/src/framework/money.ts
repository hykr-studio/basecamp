import { moneyText } from '@hykr/i18n';
import { useCallback } from 'react';
import { useLang } from './lang';

/**
 * Money as the person reads it: whole minor units and an ISO 4217 currency, in their language
 * ("€1,234.50"). Amounts arrive as `Money` from the API; nothing here assumes a currency.
 */
export function useMoneyText(): (m: { minor: number; currency: string }) => string {
  const { lang } = useLang();
  return useCallback((m) => moneyText(m, lang), [lang]);
}
