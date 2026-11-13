// The credits alerts in this application's words: the alert level and the pause each get their
// own message, to whoever holds credits.manage in the business, in their language.
import type { CreditsThresholdRow } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import {
  CreditsLowNotification,
  CreditsOutNotification,
  LimitLowNotification,
  LimitReachedNotification,
} from './index.js';

const row = (over: Partial<CreditsThresholdRow> = {}): CreditsThresholdRow => ({
  id: 'a1',
  tenantId: 't1',
  cap: 'credits',
  level: 'alert',
  usedPercent: 81.5,
  threshold: 80,
  periodStart: '2030-01-01T00:00:00.000Z',
  ...over,
});

const en = { lang: 'en' as const, timeZone: 'Asia/Kolkata' };
const hi = { lang: 'hi' as const, timeZone: 'Asia/Kolkata' };

describe('the credits alerts', () => {
  const all = [
    CreditsLowNotification,
    CreditsOutNotification,
    LimitLowNotification,
    LimitReachedNotification,
  ];

  it('the credits and a meter’s limit each get an alert and a pause, on credits.threshold', () => {
    for (const n of all) expect(n.send?.on).toEqual(['credits.threshold']);
    const fired = (r: CreditsThresholdRow) => all.filter((n) => n.when?.(r)).map((n) => n.key);
    expect(fired(row())).toEqual(['account.credits_low']);
    expect(fired(row({ level: 'pause' }))).toEqual(['account.credits_out']);
    expect(fired(row({ cap: 'embedding_tokens' }))).toEqual(['account.limit_low']);
    expect(fired(row({ cap: 'embedding_tokens', level: 'pause' }))).toEqual([
      'account.limit_reached',
    ]);
  });

  it("go to the people who manage the credits, by capability (the business's roles decide who)", () => {
    for (const n of all) expect(n.to(row())).toEqual([{ capability: 'credits.manage' }]);
  });

  it('say which cap, how much, in the reader’s language', () => {
    expect(CreditsLowNotification.whatsapp?.params(row(), en)).toEqual({
      what: 'Assistant credits',
      percent: '81',
    });
    expect(CreditsLowNotification.email?.body(row(), en)).toBe(
      'Assistant credits: 81% used this period. Add more in the app before they run out.',
    );
    expect(CreditsOutNotification.email?.subject(row({ level: 'pause' }), hi)).toBe(
      'असिस्टेंट क्रेडिट खत्म: असिस्टेंट रुका हुआ है',
    );
    expect(LimitLowNotification.whatsapp?.params(row({ cap: 'embedding_tokens' }), en).what).toBe(
      'Memory search tokens',
    );
    // A cap the application has no words for is named as it is.
    expect(LimitLowNotification.whatsapp?.params(row({ cap: 'pages_rendered' }), en).what).toBe(
      'pages_rendered',
    );
  });

  it('a limit says only what it stopped, and never to add credits (V5)', () => {
    const out = (cap: string) => row({ cap, level: 'pause', usedPercent: 100 });
    expect(LimitReachedNotification.email?.subject(out('embedding_tokens'), en)).toBe(
      'Memory search tokens: limit reached, memory search is paused (the assistant still answers)',
    );
    expect(LimitReachedNotification.email?.body(out('voice_seconds'), en)).toBe(
      "Voice minutes: this period's limit is reached, so voice calls are paused. It starts again next period.",
    );
    expect(LimitReachedNotification.whatsapp?.params(out('tool_calls'), en)).toEqual({
      what: 'Assistant actions',
      stopped: 'the assistant is paused',
    });
    expect(LimitReachedNotification.whatsapp?.params(out('voice_seconds'), hi).stopped).toBe(
      'वॉइस कॉल रुकी हुई हैं',
    );
    expect(LimitReachedNotification.email?.subject(out('pages_rendered'), en)).toBe(
      'pages_rendered: limit reached, it is paused',
    );
    expect(LimitLowNotification.email?.body(row({ cap: 'voice_seconds' }), en)).toBe(
      "Voice minutes: 81% of this period's limit is used. At the limit it pauses until the next period.",
    );
    for (const lang of ['en', 'hi', 'te'] as const)
      for (const cap of ['tokens', 'tool_calls', 'embedding_tokens', 'voice_seconds', 'messages']) {
        const reader = { lang, timeZone: 'Asia/Kolkata' };
        const words = [
          LimitReachedNotification.email?.subject(out(cap), reader),
          LimitReachedNotification.email?.body(out(cap), reader),
          LimitLowNotification.email?.body(row({ cap }), reader),
        ].join(' ');
        // Every word in the reader's language (no English left in hi or te), and no "add more".
        if (lang !== 'en') expect(words.replaceAll('WhatsApp', '')).not.toMatch(/[A-Za-z]{3,}/);
        expect(words).not.toMatch(/Add more|और जोड़ें|మరిన్ని జోడించండి/);
      }
  });
});
