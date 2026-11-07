import { describe, expect, it } from 'vitest';
import { decisionOutcome, isParkedCall, type ParkedCall, runContextOf } from './durable.js';
import { safely, type ToolContext, type ToolKit } from './tool-factory.js';

const kit = {
  clientFor: () => {
    throw new Error('not used');
  },
  registry: {},
} as unknown as ToolKit;

const parkedWrite = async () => ({
  status: 'needs_approval' as const,
  approval: { id: 'ap-1', summary: 'Close Site review' },
});

const context = (values: Record<string, unknown>) => ({
  get: (key: string) => values[key],
});

const turn = context({
  actingFor: 'user:u1',
  tenantId: 't1',
  userId: 'u1',
  runId: 'r1',
  channel: 'whatsapp',
  lang: 'hi',
  timeZone: 'Asia/Kolkata',
  surfaces: ['text'],
  screen: 'meeting',
  record: { type: 'meeting', id: 'm1' },
  canvas: { page: { title: 'big' } },
});

describe('a parked write in a tool', () => {
  it('outside an agent loop returns the parked result, as before', async () => {
    const out = await safely('close-meeting', { requestContext: turn }, kit, parkedWrite);
    expect(out).toEqual({ ok: true, result: await parkedWrite() });
  });

  it('inside one suspends the run with what it shows and how to resume the turn', async () => {
    const suspended: unknown[] = [];
    const ctx: ToolContext = {
      requestContext: turn,
      agent: { suspend: async (p) => suspended.push(p) },
    };
    const out = await safely('close-meeting', ctx, kit, parkedWrite);
    expect(suspended).toHaveLength(1);
    const parked = suspended[0] as ParkedCall;
    expect(isParkedCall(parked)).toBe(true);
    expect(parked).toEqual({
      kind: 'approval',
      approvalId: 'ap-1',
      summary: 'Close Site review',
      output: out,
      context: {
        actingFor: 'user:u1',
        tenantId: 't1',
        userId: 'u1',
        channel: 'whatsapp',
        lang: 'hi',
        timeZone: 'Asia/Kolkata',
        surfaces: ['text'],
        screen: 'meeting',
        record: { type: 'meeting', id: 'm1' },
      },
    });
  });

  it('a write that ran does not suspend', async () => {
    const suspended: unknown[] = [];
    const out = await safely(
      'create-todo',
      { requestContext: turn, agent: { suspend: async (p) => suspended.push(p) } },
      kit,
      async () => ({ status: 'done' as const, value: { id: 'x' } }),
    );
    expect(out.ok).toBe(true);
    expect(suspended).toEqual([]);
  });
});

describe('a resumed call', () => {
  const parked: ParkedCall = {
    kind: 'approval',
    approvalId: 'ap-1',
    summary: 'Close Site review',
    output: { ok: true },
    context: { actingFor: 'user:u1' },
  };
  const resumedWith = (resumeData: unknown) => {
    let called = 0;
    const run = safely(
      'close-meeting',
      { requestContext: turn, agent: { resumeData, suspendPayload: parked } },
      kit,
      async () => {
        called++;
        return parkedWrite();
      },
    );
    return run.then((out) => ({ out, called }));
  };

  it('answers with the decision and never calls the API again', async () => {
    const approved = await resumedWith({ approvalId: 'ap-1', status: 'approved' });
    expect(approved.called).toBe(0);
    expect(approved.out).toEqual({
      ok: true,
      result: {
        status: 'approved',
        approval: {
          id: 'ap-1',
          status: 'approved',
          summary: 'Close Site review',
          resourceType: null,
          resourceId: null,
          decidedAt: null,
        },
      },
    });
    expect((await resumedWith({ approvalId: 'ap-1', status: 'rejected' })).out).toMatchObject({
      ok: true,
      result: { status: 'rejected' },
    });
    expect((await resumedWith({ approvalId: 'ap-1', status: 'expired' })).out).toMatchObject({
      ok: true,
      result: { status: 'expired' },
    });
  });

  it('an approved request that could not be done reads as a refusal, with why', async () => {
    const failed = await resumedWith({
      approvalId: 'ap-1',
      status: 'failed',
      reason: 'This meeting is already closed',
    });
    expect(failed.out).toMatchObject({
      ok: false,
      status: 409,
      error: { error: 'approval_failed', reason: 'This meeting is already closed' },
    });
  });

  it('refuses a decision about another approval, or no decision at all', async () => {
    for (const data of [{ approvalId: 'ap-2', status: 'approved' }, { approved: true }, 'yes']) {
      const { out, called } = await resumedWith(data);
      expect(called).toBe(0);
      expect(out).toMatchObject({ ok: false, error: { error: 'not_decided' } });
    }
    expect(decisionOutcome(undefined, { approvalId: 'ap-1', status: 'approved' }).ok).toBe(false);
  });
});

describe('runContextOf', () => {
  it('keeps only what a resume needs, never the canvas page', () => {
    expect(runContextOf(context({ userId: 'u9' }))).toEqual({ actingFor: 'u9', userId: 'u9' });
    expect(runContextOf(turn)).not.toHaveProperty('canvas');
    expect(runContextOf(undefined)).toEqual({ actingFor: '' });
  });
});
