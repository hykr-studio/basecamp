import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (s: unknown) => s },
  Text: 'Text',
  View: 'View',
  Platform: { OS: 'web' },
}));
vi.mock('../../components/Button', () => ({ Button: 'Button' }));
vi.mock('../../framework/hooks', () => ({ useApprovals: () => ({ approvals: [] }) }));
vi.mock('../../framework/Icon', () => ({ Icon: 'Icon' }));
vi.mock('../../framework/lang', () => ({ useT: () => ({ t: (k: string) => k }) }));
vi.mock('../../theme', () => ({ colors: {}, space: {}, styles: {} }));
vi.mock('../inbox/hooks', () => ({ useInboxCount: () => 0 }));
vi.mock('./web', () => ({ usePushStatus: () => undefined }));

const { shouldOffer } = await import('./PushControls');

describe('the offer to turn notifications on', () => {
  it('waits until something is waiting for the person', () => {
    expect(shouldOffer('off', false, 0)).toBe(false);
    expect(shouldOffer('off', false, 1)).toBe(true);
  });

  it('never when they are on, blocked or unsupported, or the person said not now', () => {
    for (const status of ['on', 'blocked', 'unsupported', undefined] as const)
      expect(shouldOffer(status, false, 3)).toBe(false);
    expect(shouldOffer('off', true, 3)).toBe(false);
  });
});
