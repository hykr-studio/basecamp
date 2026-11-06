// The seams the write path will build on: approval checks that see the payload, and decisions
// that carry what is at stake. Pure: no database, no domain.
import {
  type ApprovalRule,
  AuthorizeResult,
  entitySpec,
  type Principal,
  parksFor,
} from '@hykr/contracts';
import { integer, pgSchema, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { allow, deny, needsApproval } from './authorize.js';
import { defineEntity } from './entity/define-entity.js';

const ana: Principal = {
  actor: { kind: 'user', id: 'ana', role: 'owner' },
  subject: { kind: 'user', userId: 'ana' },
  tenantId: 't1',
  roles: ['owner'],
  scopes: [],
};

describe('approval rules see the action, the input and the row', () => {
  const big = { action: 'create', input: { amount: 500 }, row: null };
  const small = { action: 'create', input: { amount: 50 }, row: null };

  it('the function form', () => {
    const rule: ApprovalRule = (_p, { input }) => Number(input?.amount ?? 0) > 100;
    expect(parksFor(rule, ana, big)).toBe(true);
    expect(parksFor(rule, ana, small)).toBe(false);
    // A tool's description knows no payload yet.
    expect(parksFor(rule, ana, { action: 'create', input: null, row: null })).toBe(false);
  });

  it("the object form's when, and a check on the requester alone still works", () => {
    const seen: unknown[] = [];
    const rule: ApprovalRule = {
      by: ['owner'],
      when: (_p, ctx) => {
        seen.push(ctx);
        return ctx.action === 'update' && ctx.row?.locked === true;
      },
    };
    const ctx = { action: 'update', input: { title: 'x' }, row: { locked: true } };
    expect(parksFor(rule, ana, ctx)).toBe(true);
    expect(seen).toEqual([ctx]);
    expect(parksFor((p) => p.actor.kind === 'agent', ana, ctx)).toBe(false);
  });

  it("an entity's decision parks on its payload", () => {
    const Spec = entitySpec({
      name: 'order',
      label: 'order',
      description: 'Orders.',
      schemas: {
        read: z.object({ id: z.string() }),
        create: z.object({ amount: z.number() }),
        update: z.object({ amount: z.number().optional() }),
      },
      list: {
        filterable: {},
        sortable: [],
        defaultSort: [],
        search: [],
        pageSize: { default: 10, max: 10 },
      },
      approval: { create: (_p, { input }) => Number(input?.amount ?? 0) > 100 },
    });
    const orders = pgSchema('app').table('seam_orders', {
      id: text('id').primaryKey(),
      tenantId: text('tenant_id').notNull(),
      ownerId: text('owner_id').notNull(),
      amount: integer('amount').notNull(),
    });
    const Order = defineEntity(Spec, { table: orders, owner: (t) => t.ownerId });
    expect(Order.decide(ana, 'create', null, { amount: 500 }).decision).toBe('needs_approval');
    expect(Order.decide(ana, 'create', null, { amount: 50 }).decision).toBe('allow');
  });
});

describe('decisions carry what is at stake', () => {
  it('the helpers keep the tier, approver, amount and undo window', () => {
    const parked = needsApproval('order_send', 'Sends to a client wait', {
      tier: 3,
      approver: { userId: 'ana', channels: ['app'], minAssurance: 'session' },
      amount: 250_000,
      undoMs: 0,
    });
    expect(AuthorizeResult.parse(parked)).toEqual({
      decision: 'needs_approval',
      rule: 'order_send',
      reason: 'Sends to a client wait',
      tier: 3,
      approver: { userId: 'ana', channels: ['app'], minAssurance: 'session' },
      amount: 250_000,
      undoMs: 0,
    });
    expect(allow('note_edit', undefined, { tier: 1, undoMs: 30_000 })).toMatchObject({
      reason: 'note_edit',
      tier: 1,
      undoMs: 30_000,
    });
    // Without details, a decision is what it was.
    expect(deny('no', 'No')).toEqual({ decision: 'deny', rule: 'no', reason: 'No' });
  });

  it('a tier is 0 to 3, and an amount is whole minor units', () => {
    const base = { decision: 'allow', rule: 'r', reason: 'r' };
    expect(AuthorizeResult.safeParse({ ...base, tier: 4 }).success).toBe(false);
    expect(AuthorizeResult.safeParse({ ...base, amount: 10.5 }).success).toBe(false);
  });
});
