/**
 * The credits alerts, in this application's words: the framework raises `credits.threshold`
 * when a cap (the business's credits, or a meter's limit) reaches its alert or pause level, and
 * these tell the people who manage the credits (whoever holds `credits.manage` in the business,
 * by its own roles too), on WhatsApp, else by email.
 */
import { CreditsManageCapability, type CreditsThresholdRow } from '@hykr/contracts';
import { type Labels, type Lang, pick } from '@hykr/i18n';
import { defineNotification, defineTemplate, type Reader } from '@hykr/notifications';
import { z } from 'zod';
import { PrivacyLateNotification, PrivacyWaitsNotification } from './privacy.js';

export { PrivacyLateNotification, PrivacyWaitsNotification } from './privacy.js';

export const CreditsLow = defineTemplate({
  name: 'credits_low_v1',
  category: 'utility',
  params: z.object({ what: z.string().max(60), percent: z.string().max(5) }),
  body: {
    en: '{{what}}: {{percent}}% used this period. Add more in the app before they run out.',
    hi: '{{what}}: इस अवधि में {{percent}}% उपयोग हो गया। खत्म होने से पहले ऐप में और जोड़ें।',
    te: '{{what}}: ఈ వ్యవధిలో {{percent}}% వాడారు. అయిపోయే ముందు యాప్‌లో మరిన్ని జోడించండి.',
  },
  example: { what: 'Assistant credits', percent: '80' },
});

export const CreditsOut = defineTemplate({
  name: 'credits_out_v1',
  category: 'utility',
  params: z.object({ what: z.string().max(60) }),
  body: {
    en: '{{what}} are used up for this period, so the assistant is paused. Add more in the app to carry on.',
    hi: 'इस अवधि के {{what}} खत्म हो गए, इसलिए असिस्टेंट रुका हुआ है। जारी रखने के लिए ऐप में और जोड़ें।',
    te: 'ఈ వ్యవధికి {{what}} అయిపోయాయి, అందుకే అసిస్టెంట్ ఆగిపోయింది. కొనసాగించడానికి యాప్‌లో మరిన్ని జోడించండి.',
  },
  example: { what: 'Assistant credits' },
});

/** What each cap is called: the credits themselves, or a meter with a limit. */
const CAPS: Record<string, Labels> = {
  credits: { en: 'Assistant credits', hi: 'असिस्टेंट क्रेडिट', te: 'అసిస్టెంట్ క్రెడిట్‌లు' },
  tokens: { en: 'Assistant tokens', hi: 'असिस्टेंट टोकन', te: 'అసిస్టెంట్ టోకెన్‌లు' },
  tool_calls: { en: 'Assistant actions', hi: 'असिस्टेंट के काम', te: 'అసిస్టెంట్ చర్యలు' },
  messages: { en: 'WhatsApp messages', hi: 'WhatsApp संदेश', te: 'WhatsApp సందేశాలు' },
  voice_seconds: { en: 'Voice minutes', hi: 'वॉइस मिनट', te: 'వాయిస్ నిమిషాలు' },
  embedding_tokens: {
    en: 'Memory search tokens',
    hi: 'मेमोरी खोज टोकन',
    te: 'మెమరీ శోధన టోకెన్‌లు',
  },
};

const what = (row: CreditsThresholdRow, lang: Lang) =>
  CAPS[row.cap] ? pick(CAPS[row.cap], lang) : row.cap;

const LOW: Record<Lang, (what: string, percent: number) => string> = {
  en: (w, p) => `${w}: ${p}% used`,
  hi: (w, p) => `${w}: ${p}% उपयोग हुआ`,
  te: (w, p) => `${w}: ${p}% వాడారు`,
};
const OUT: Record<Lang, (what: string) => string> = {
  en: (w) => `${w} used up: the assistant is paused`,
  hi: (w) => `${w} खत्म: असिस्टेंट रुका हुआ है`,
  te: (w) => `${w} అయిపోయాయి: అసిస్టెంట్ ఆగిపోయింది`,
};

/** The people who manage the business's credits, found with its roles when the alert is sent. */
const managers = () => [{ capability: CreditsManageCapability.name }];

const lowParams = (row: CreditsThresholdRow, r: Reader) => ({
  what: what(row, r.lang),
  percent: String(Math.floor(row.usedPercent)),
});

/** At the alert level (80% by default) of a cap. */
export const CreditsLowNotification = defineNotification<CreditsThresholdRow>({
  key: 'account.credits_low',
  topic: 'service',
  send: { on: ['credits.threshold'] },
  when: (row) => row.level === 'alert',
  to: managers,
  channels: ['whatsapp', 'email'],
  whatsapp: { template: CreditsLow, params: lowParams },
  email: {
    subject: (row, r) => LOW[r.lang](what(row, r.lang), Math.floor(row.usedPercent)),
    body: (row, r) =>
      CreditsLow.body[r.lang].replace(
        /\{\{(\w+)\}\}/g,
        (_, k: 'what' | 'percent') => lowParams(row, r)[k],
      ),
  },
  dedupe: (row) => `account.credits_low:${row.id}`,
});

/** At the pause level (100% by default): what the cap covers has stopped. */
export const CreditsOutNotification = defineNotification<CreditsThresholdRow>({
  key: 'account.credits_out',
  topic: 'service',
  send: { on: ['credits.threshold'] },
  when: (row) => row.level === 'pause',
  to: managers,
  channels: ['whatsapp', 'email'],
  whatsapp: { template: CreditsOut, params: (row, r) => ({ what: what(row, r.lang) }) },
  email: {
    subject: (row, r) => OUT[r.lang](what(row, r.lang)),
    body: (row, r) => CreditsOut.body[r.lang].replace('{{what}}', what(row, r.lang)),
  },
  dedupe: (row) => `account.credits_out:${row.id}`,
});

export const accountNotifications = {
  templates: [CreditsLow, CreditsOut],
  notifications: [
    CreditsLowNotification,
    CreditsOutNotification,
    PrivacyWaitsNotification,
    PrivacyLateNotification,
  ],
};
