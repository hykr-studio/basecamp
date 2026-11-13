/**
 * The credits alerts, in this application's words: the framework raises `credits.threshold`
 * when a cap (the business's credits, or a meter's limit) reaches its alert or pause level, and
 * these tell the people who manage the credits (whoever holds `credits.manage` in the business,
 * by its own roles too), on WhatsApp, else by email. The credits and a meter's limit are worded
 * apart: credits can be added, a limit starts again next period, and a limit stops only what
 * its meter covers (memory search, voice), not always the assistant.
 */
import { CreditsManageCapability, type CreditsThresholdRow } from '@hykr/contracts';
import { type Labels, type Lang, type PerLang, pick } from '@hykr/i18n';
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

export const LimitLow = defineTemplate({
  name: 'limit_low_v1',
  category: 'utility',
  params: z.object({ what: z.string().max(60), percent: z.string().max(5) }),
  body: {
    en: "{{what}}: {{percent}}% of this period's limit is used. At the limit it pauses until the next period.",
    hi: '{{what}}: इस अवधि की सीमा का {{percent}}% उपयोग हो गया। सीमा पर पहुँचने पर यह अगली अवधि तक रुक जाएगा।',
    te: '{{what}}: ఈ వ్యవధి పరిమితిలో {{percent}}% వాడారు. పరిమితికి చేరితే తదుపరి వ్యవధి వరకు ఆగిపోతుంది.',
  },
  example: { what: 'Voice minutes', percent: '80' },
});

export const LimitReached = defineTemplate({
  name: 'limit_reached_v1',
  category: 'utility',
  params: z.object({ what: z.string().max(60), stopped: z.string().max(80) }),
  body: {
    en: "{{what}}: this period's limit is reached, so {{stopped}}. It starts again next period.",
    hi: '{{what}}: इस अवधि की सीमा पूरी हो गई, इसलिए {{stopped}}। यह अगली अवधि में फिर शुरू होगा।',
    te: '{{what}}: ఈ వ్యవధి పరిమితి పూర్తయింది, అందుకే {{stopped}}. తదుపరి వ్యవధిలో మళ్లీ మొదలవుతుంది.',
  },
  example: { what: 'Voice minutes', stopped: 'voice calls are paused' },
});

/** The budget: the business's credits (`cap: 'credits'`). Any other cap is a meter's limit. */
const CREDITS = 'credits';

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

/**
 * The cap in this application's words, else as the event names it (a module's meter, by the
 * label it declares), else as it is (an event stored without one).
 */
const what = (row: CreditsThresholdRow, lang: Lang) =>
  CAPS[row.cap] ? pick(CAPS[row.cap], lang) : row.label ? pick(row.label, lang) : row.cap;

const ASSISTANT_PAUSED: Labels = {
  en: 'the assistant is paused',
  hi: 'असिस्टेंट रुका हुआ है',
  te: 'అసిస్టెంట్ ఆగిపోయింది',
};

/** What stops when a meter's limit is reached: only what that meter covers. */
const STOPPED: Record<string, Labels> = {
  tokens: ASSISTANT_PAUSED,
  tool_calls: ASSISTANT_PAUSED,
  embedding_tokens: {
    en: 'memory search is paused (the assistant still answers)',
    hi: 'मेमोरी खोज रुकी हुई है (असिस्टेंट अब भी जवाब देता है)',
    te: 'మెమరీ శోధన ఆగిపోయింది (అసిస్టెంట్ ఇంకా జవాబిస్తుంది)',
  },
  voice_seconds: {
    en: 'voice calls are paused',
    hi: 'वॉइस कॉल रुकी हुई हैं',
    te: 'వాయిస్ కాల్‌లు ఆగిపోయాయి',
  },
  messages: {
    en: 'messages of the kinds your plan pauses are not sent',
    hi: 'आपकी योजना जिन तरह के संदेश रोकती है, वे नहीं भेजे जाते',
    te: 'మీ ప్లాన్ ఆపే రకాల సందేశాలు పంపబడవు',
  },
};
const STOPPED_ELSE: Labels = { en: 'it is paused', hi: 'यह रुका हुआ है', te: 'ఇది ఆగిపోయింది' };

const stopped = (row: CreditsThresholdRow, lang: Lang) =>
  pick(STOPPED[row.cap] ?? STOPPED_ELSE, lang);

/** A template's body with its parameters filled in: the email says what WhatsApp would. */
const fill = (body: string, params: Record<string, string>) =>
  body.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '');

const LOW: PerLang<(what: string, percent: number) => string> = {
  en: (w, p) => `${w}: ${p}% used`,
  hi: (w, p) => `${w}: ${p}% उपयोग हुआ`,
  te: (w, p) => `${w}: ${p}% వాడారు`,
};
const OUT: PerLang<(what: string) => string> = {
  en: (w) => `${w} used up: the assistant is paused`,
  hi: (w) => `${w} खत्म: असिस्टेंट रुका हुआ है`,
  te: (w) => `${w} అయిపోయాయి: అసిస్టెంట్ ఆగిపోయింది`,
};
const LIMIT_LOW: PerLang<(what: string, percent: number) => string> = {
  en: (w, p) => `${w}: ${p}% of the limit used`,
  hi: (w, p) => `${w}: सीमा का ${p}% उपयोग हुआ`,
  te: (w, p) => `${w}: పరిమితిలో ${p}% వాడారు`,
};
const LIMIT_OUT: PerLang<(what: string, stopped: string) => string> = {
  en: (w, s) => `${w}: limit reached, ${s}`,
  hi: (w, s) => `${w}: सीमा पूरी, ${s}`,
  te: (w, s) => `${w}: పరిమితి పూర్తయింది, ${s}`,
};

/** The people who manage the business's credits, found with its roles when the alert is sent. */
const managers = () => [{ capability: CreditsManageCapability.name }];

const lowParams = (row: CreditsThresholdRow, r: Reader) => ({
  what: what(row, r.lang),
  percent: String(Math.floor(row.usedPercent)),
});

/** At the alert level (80% by default) of the credits. */
export const CreditsLowNotification = defineNotification<CreditsThresholdRow>({
  key: 'account.credits_low',
  topic: 'service',
  send: { on: ['credits.threshold'] },
  when: (row) => row.level === 'alert' && row.cap === CREDITS,
  to: managers,
  channels: ['whatsapp', 'email'],
  whatsapp: { template: CreditsLow, params: lowParams },
  email: {
    subject: (row, r) => pick(LOW, r.lang)(what(row, r.lang), Math.floor(row.usedPercent)),
    body: (row, r) => fill(pick(CreditsLow.body, r.lang), lowParams(row, r)),
  },
  dedupe: (row) => `account.credits_low:${row.id}`,
});

/** At the pause level (100% by default) of the credits: the assistant has stopped. */
export const CreditsOutNotification = defineNotification<CreditsThresholdRow>({
  key: 'account.credits_out',
  topic: 'service',
  send: { on: ['credits.threshold'] },
  when: (row) => row.level === 'pause' && row.cap === CREDITS,
  to: managers,
  channels: ['whatsapp', 'email'],
  whatsapp: { template: CreditsOut, params: (row, r) => ({ what: what(row, r.lang) }) },
  email: {
    subject: (row, r) => pick(OUT, r.lang)(what(row, r.lang)),
    body: (row, r) => fill(pick(CreditsOut.body, r.lang), { what: what(row, r.lang) }),
  },
  dedupe: (row) => `account.credits_out:${row.id}`,
});

/** At the alert level of a meter's limit: adding credits does not raise it. */
export const LimitLowNotification = defineNotification<CreditsThresholdRow>({
  key: 'account.limit_low',
  topic: 'service',
  send: { on: ['credits.threshold'] },
  when: (row) => row.level === 'alert' && row.cap !== CREDITS,
  to: managers,
  channels: ['whatsapp', 'email'],
  whatsapp: { template: LimitLow, params: lowParams },
  email: {
    subject: (row, r) => pick(LIMIT_LOW, r.lang)(what(row, r.lang), Math.floor(row.usedPercent)),
    body: (row, r) => fill(pick(LimitLow.body, r.lang), lowParams(row, r)),
  },
  dedupe: (row) => `account.limit_low:${row.id}`,
});

const reachedParams = (row: CreditsThresholdRow, r: Reader) => ({
  what: what(row, r.lang),
  stopped: stopped(row, r.lang),
});

/** At the pause level of a meter's limit: only what that meter covers has stopped. */
export const LimitReachedNotification = defineNotification<CreditsThresholdRow>({
  key: 'account.limit_reached',
  topic: 'service',
  send: { on: ['credits.threshold'] },
  when: (row) => row.level === 'pause' && row.cap !== CREDITS,
  to: managers,
  channels: ['whatsapp', 'email'],
  whatsapp: { template: LimitReached, params: reachedParams },
  email: {
    subject: (row, r) => pick(LIMIT_OUT, r.lang)(what(row, r.lang), stopped(row, r.lang)),
    body: (row, r) => fill(pick(LimitReached.body, r.lang), reachedParams(row, r)),
  },
  dedupe: (row) => `account.limit_reached:${row.id}`,
});

export const accountNotifications = {
  templates: [CreditsLow, CreditsOut, LimitLow, LimitReached],
  notifications: [
    CreditsLowNotification,
    CreditsOutNotification,
    LimitLowNotification,
    LimitReachedNotification,
    PrivacyWaitsNotification,
    PrivacyLateNotification,
  ],
};
