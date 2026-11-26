// The push token's mask (A9, V7): enough to tell devices apart, never the token whole.
import { describe, expect, it } from 'vitest';
import { maskToken } from '../../dist/features/push/push.service.js';

describe('maskToken', () => {
  it("keeps an Expo token's prefix and 6 characters of its id", () => {
    expect(maskToken('ExponentPushToken[abcdefghijklmnopqrstuv]')).toBe(
      'ExponentPushToken[abcdef…',
    );
    expect(maskToken('ExpoPushToken[zyxwvutsrqponmlkjihgfe]')).toBe('ExpoPushToken[zyxwvu…');
    expect(maskToken('fcm-0123456789abcdef')).toBe('fcm-0123…');
  });

  it('never shows a short token whole', () => {
    expect(maskToken('ExponentPushToken[ab]')).toBe('ExponentPushToken[a…');
    expect(maskToken('ExponentPushToken[]')).toBe('ExponentPushToken[…');
    expect(maskToken('abcdefgh')).toBe('abcd…');
    expect(maskToken('a')).toBe('…');
  });
});
