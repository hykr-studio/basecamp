/**
 * Privacy requests, in this application's words: the framework raises
 * `privacy.request.received` when a person's request waits for review and
 * `privacy.request.overdue` when one is past its deadline; these tell the people who handle
 * privacy requests (`privacy.manage`) in their in-app inbox, else by email.
 */
import type { PrivacyRequest } from '@hykr/contracts';
import { type PerLang, pick } from '@hykr/i18n';
import { defineNotification } from '@hykr/notifications';

/** A request as the framework's events carry it (no note), with its business. */
export type PrivacyRequestRow = Omit<PrivacyRequest, 'note'> & { tenantId: string };

const KIND: PerLang<Record<PrivacyRequest['kind'], string>> = {
  en: { export: 'a copy of their data', erase: 'their data erased' },
  hi: { export: 'अपने डेटा की कॉपी', erase: 'अपना डेटा मिटाना' },
  te: { export: 'తమ డేటా కాపీ', erase: 'తమ డేటా తొలగింపు' },
};

const WAITS: PerLang<{ title: string; body: (kind: string) => string }> = {
  en: {
    title: 'A privacy request waits for you',
    body: (k) => `Someone asked for ${k}. Review it in the back office.`,
  },
  hi: {
    title: 'एक निजता अनुरोध आपकी प्रतीक्षा में है',
    body: (k) => `किसी ने ${k} माँगा है। बैक ऑफ़िस में देखें।`,
  },
  te: {
    title: 'ఒక గోప్యతా అభ్యర్థన మీ కోసం వేచి ఉంది',
    body: (k) => `ఎవరో ${k} అడిగారు. బ్యాక్ ఆఫీస్‌లో చూడండి.`,
  },
};

const LATE: PerLang<{ title: string; body: (kind: string) => string }> = {
  en: {
    title: 'A privacy request is past its deadline',
    body: (k) => `A request for ${k} is still open after its deadline. Answer it now.`,
  },
  hi: {
    title: 'एक निजता अनुरोध की समय-सीमा निकल गई',
    body: (k) => `${k} का अनुरोध समय-सीमा के बाद भी खुला है। अभी जवाब दें।`,
  },
  te: {
    title: 'ఒక గోప్యతా అభ్యర్థన గడువు దాటింది',
    body: (k) => `${k} కోసం అభ్యర్థన గడువు తర్వాత కూడా తెరిచే ఉంది. ఇప్పుడే జవాబివ్వండి.`,
  },
};

const PRIVACY_TEAM = [{ capability: 'privacy.manage' }];

/** A person's own request waits for someone to review it. */
export const PrivacyWaitsNotification = defineNotification<PrivacyRequestRow>({
  key: 'account.privacy_waits',
  topic: 'service',
  send: { on: ['privacy.request.received'] },
  to: () => PRIVACY_TEAM,
  channels: ['inapp', 'email'],
  inapp: {
    title: (_row, r) => pick(WAITS, r.lang).title,
    body: (row, r) => pick(WAITS, r.lang).body(pick(KIND, r.lang)[row.kind]),
  },
  email: {
    subject: (_row, r) => pick(WAITS, r.lang).title,
    body: (row, r) => pick(WAITS, r.lang).body(pick(KIND, r.lang)[row.kind]),
  },
  dedupe: (row) => `account.privacy_waits:${row.id}`,
});

/** A request is still open after its deadline. */
export const PrivacyLateNotification = defineNotification<PrivacyRequestRow>({
  key: 'account.privacy_late',
  topic: 'service',
  send: { on: ['privacy.request.overdue'] },
  to: () => PRIVACY_TEAM,
  channels: ['inapp', 'email'],
  inapp: {
    title: (_row, r) => pick(LATE, r.lang).title,
    body: (row, r) => pick(LATE, r.lang).body(pick(KIND, r.lang)[row.kind]),
  },
  email: {
    subject: (_row, r) => pick(LATE, r.lang).title,
    body: (row, r) => pick(LATE, r.lang).body(pick(KIND, r.lang)[row.kind]),
  },
  dedupe: (row) => `account.privacy_late:${row.id}`,
});
