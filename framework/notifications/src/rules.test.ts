import { describe, expect, it } from 'vitest';
import { quietUntil, underMarketingCap } from './rules.js';

const IST = { from: '21:00', to: '09:00', timeZone: 'Asia/Kolkata' };

describe('quiet hours', () => {
  it('nothing between 9pm and 9am in the business zone; the end is 9am there', () => {
    // 10:00 IST = 04:30 UTC: may go.
    expect(quietUntil(new Date('2026-10-08T04:30:00Z'), IST)).toBeNull();
    // 22:30 IST = 17:00 UTC: waits until 09:00 IST next day = 03:30 UTC.
    expect(quietUntil(new Date('2026-10-08T17:00:00Z'), IST)?.toISOString()).toBe(
      '2026-10-09T03:30:00.000Z',
    );
    // 02:00 IST = 20:30 UTC the day before: waits until 09:00 IST the same morning.
    expect(quietUntil(new Date('2026-10-07T20:30:00Z'), IST)?.toISOString()).toBe(
      '2026-10-08T03:30:00.000Z',
    );
  });

  it('quiet hours that do not cross midnight', () => {
    const lunch = { from: '13:00', to: '14:00', timeZone: 'UTC' };
    expect(quietUntil(new Date('2026-10-08T13:20:00Z'), lunch)?.toISOString()).toBe(
      '2026-10-08T14:00:00.000Z',
    );
    expect(quietUntil(new Date('2026-10-08T14:00:00Z'), lunch)).toBeNull();
  });

  it('marketing stops at the weekly cap', () => {
    expect(underMarketingCap(0, 1)).toBe(true);
    expect(underMarketingCap(1, 1)).toBe(false);
  });
});
