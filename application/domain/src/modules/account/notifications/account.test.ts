// The credits alerts in this application's words: the alert level and the pause each get their
// own message, to whoever holds credits.manage in the business, in their language.
import type { CreditsThresholdRow } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { CreditsLowNotification, CreditsOutNotification } from './index.js';

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
  it('one at the alert level, one at the pause, each on credits.threshold', () => {
    for (const n of [CreditsLowNotification, CreditsOutNotification])
      expect(n.send?.on).toEqual(['credits.threshold']);
    expect(CreditsLowNotification.when?.(row())).toBe(true);
    expect(CreditsOutNotification.when?.(row())).toBe(false);
    expect(CreditsOutNotification.when?.(row({ level: 'pause' }))).toBe(true);
  });

  it("go to the people who manage the credits, by capability (the business's roles decide who)", () => {
    for (const n of [CreditsLowNotification, CreditsOutNotification])
      expect(n.to(row())).toEqual([{ capability: 'credits.manage' }]);
  });

  it('say which cap, how much, in the reader’s language', () => {
    expect(CreditsLowNotification.whatsapp?.params(row(), en)).toEqual({
      what: 'Assistant credits',
      percent: '81',
    });
    expect(CreditsLowNotification.email?.body(row(), en)).toBe(
      'Assistant credits: 81% used this period. Add more in the app before they run out.',
    );
    expect(
      CreditsOutNotification.email?.subject(row({ cap: 'voice_seconds', level: 'pause' }), hi),
    ).toBe('वॉइस मिनट खत्म: असिस्टेंट रुका हुआ है');
    expect(CreditsLowNotification.whatsapp?.params(row({ cap: 'embedding_tokens' }), en).what).toBe(
      'Memory search tokens',
    );
    // A cap the application has no words for is named as it is.
    expect(CreditsLowNotification.whatsapp?.params(row({ cap: 'pages_rendered' }), en).what).toBe(
      'pages_rendered',
    );
  });
});
