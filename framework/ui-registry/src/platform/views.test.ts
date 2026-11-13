import { describe, expect, it } from 'vitest';
import { ApprovalCardView } from './views.js';

const ctx = { lang: 'en' as const, timeZone: 'UTC' };

describe('the approval card in words (V7)', () => {
  it("says whose approval it waits for: the person's, or the team's", () => {
    const card = { approvalId: 'ap1', summary: 'Delete "Tiles"' };
    expect(ApprovalCardView.text(card, ctx)).toBe(
      'Waiting for your approval: Delete "Tiles". Approve or reject it in the app.',
    );
    expect(ApprovalCardView.text({ ...card, canDecide: false }, ctx)).toBe(
      'Waiting for the team\'s approval: Delete "Tiles".',
    );
    expect(ApprovalCardView.speak({ ...card, canDecide: false }, ctx)).toBe(
      'Delete "Tiles" is waiting for the team\'s approval.',
    );
  });
});
