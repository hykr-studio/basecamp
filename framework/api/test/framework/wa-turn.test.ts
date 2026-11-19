// Who decides what a WhatsApp turn parked (V7): the inbound turn and a continuation keep only
// what this person decides themselves, the same fact the waiting line reads (`mayDecide`), so a
// request someone else decides gets no buttons and no "approve it in the app" beside the line
// that says the team was asked. No database: the filter is a pure function of the rows.
import { parkedLine } from '@hykr/agents';
import { render } from '@hykr/channels';
import type { Principal } from '@hykr/contracts';
import { mayDecide } from '@hykr/core';
import { describe, expect, it } from 'vitest';
import { keepOwn, toRenderTurn } from '../../dist/channels/whatsapp/turn.js';

type Row = Parameters<typeof keepOwn>[1][number];
const T = 'tenant-1';
const DECIDE = 'approvals.decide';
const row = (id: string, over: Partial<Row>): Row =>
  ({
    id,
    tenantId: T,
    ownerId: null,
    requesterContactId: null,
    approverUserId: null,
    approverCapability: null,
    approverChannels: null,
    status: 'pending',
    ...over,
  }) as Row;
const member = (userId: string, capabilities: string[] = []): Principal => ({
  actor: { kind: 'agent', id: 'agent' },
  subject: { kind: 'user', userId },
  tenantId: T,
  capabilities,
  scopes: [],
});
const contact = (contactId: string, capabilities: string[] = []): Principal => ({
  actor: { kind: 'agent', id: 'agent' },
  subject: { kind: 'contact', contactId },
  tenantId: T,
  capabilities,
  scopes: [],
});
const parked = (approvalId: string, detail: string) => ({
  tool: 'delete-task',
  outcome: 'parked' as const,
  approvalId,
  detail,
});

describe('a WhatsApp turn keeps what this person decides', () => {
  it('her own request, named to her, stays; the one her capability holders decide leaves', () => {
    const ana = member('ana', [DECIDE]);
    const turn = toRenderTurn({
      reply: 'x',
      runId: 'r',
      threadId: 't',
      toolCalls: [parked('mine', 'Delete "A"'), parked('team', 'Delete "B"'), parked('gone', 'C')],
    } as never);
    const rows = [
      row('mine', { ownerId: 'ana', approverUserId: 'ana' }),
      // She holds the capability, but she asked: never hers to decide.
      row('team', { ownerId: 'ana', approverCapability: DECIDE }),
      // Another business's row with the same id is not hers.
      row('gone', { tenantId: 'other', approverUserId: 'ana' }),
    ];
    const { turn: kept, own } = keepOwn(turn, rows, ana);
    expect(kept.approvals.map((a) => a.id)).toEqual(['mine']);
    expect([...own.keys()]).toEqual(['mine']);
  });

  it('a continuation that parks a request the team decides says it once, with no link', () => {
    const ana = member('ana');
    const reply = parkedLine({ summary: 'Delete "Order tiles"', canDecide: false });
    const turn = toRenderTurn({
      reply,
      runId: 'r',
      threadId: 't',
      toolCalls: [parked('ap-1', 'Delete "Order tiles"')],
    } as never);
    const rows = [row('ap-1', { ownerId: 'ana', approverCapability: DECIDE })];
    const messages = render(keepOwn(turn, rows, ana).turn, {
      to: '91',
      lang: 'en',
      appUrl: 'http://app',
    });
    expect(messages).toEqual([{ kind: 'text', to: '91', text: reply }]);
    expect(reply).toBe(
      `I've asked the team for approval: Delete "Order tiles". Nothing changes until they decide.`,
    );
    // Without the filter, the same turn adds the link that contradicts it.
    const unfiltered = render(turn, { to: '91', lang: 'en', appUrl: 'http://app' });
    expect(JSON.stringify(unfiltered)).toContain('http://app/approvals/ap-1');
  });

  it("a contact holding the decider's capability never decides its own request", () => {
    const kavya = contact('c-kavya', [DECIDE]);
    const own = row('k', { requesterContactId: 'c-kavya', approverCapability: DECIDE });
    const others = row('m', { requesterContactId: 'c-meena', approverCapability: DECIDE });
    expect(mayDecide(own, kavya)).toBe(false);
    expect(mayDecide(others, kavya)).toBe(true);
    const turn = toRenderTurn({
      reply: 'x',
      runId: 'r',
      threadId: 't',
      toolCalls: [parked('k', 'Delete "K"')],
    } as never);
    expect(keepOwn(turn, [own], kavya).turn.approvals).toEqual([]);
  });
});
