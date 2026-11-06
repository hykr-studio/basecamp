// Approval levels as an application declares them (A5): four levels of its own, a level rule
// that reads the input, the row and the business's settings (a threshold, and approvers per
// amount band), a command that sends to someone outside the business, and a field hidden from
// staff that must stay hidden on approval cards. Only the approval-levels e2e test's server
// (`approvalLevelsApp`) loads this file; the levels, rule and capability are its own.
import { defineModule, defineServer } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  commandSpec,
  defineApprovalLevel,
  defineCapability,
  entitySpec,
  type Money,
  moduleSpec,
  overThreshold,
} from '@hykr/contracts';
import {
  allow,
  atLevel,
  commandController,
  commandHandler,
  defineCommand,
  defineEntity,
  defineLevelRule,
  entityController,
  entityHandlers,
  type NamedEvent,
  type ReadProjector,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { levelPayments } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });

/** Read only: runs. */
export const LookLevel = defineApprovalLevel({
  name: 'fixture_look',
  rank: 0,
  label: label('Look'),
});
/** An internal change: runs, and can be undone for 30 seconds. */
export const InternalLevel = defineApprovalLevel({
  name: 'fixture_internal',
  rank: 1,
  label: label('Internal'),
  policy: { parks: false, undoMs: 30_000 },
});
/**
 * Reaches someone outside the business: waits when the assistant does it (the person decides),
 * and a business may let it run.
 */
export const OutsideLevel = defineApprovalLevel({
  name: 'fixture_outside',
  rank: 2,
  label: label('Outside'),
  policy: { parks: (p) => p.actor.kind !== 'user', tenantMayLoosen: true },
});
/**
 * Cannot be taken back: always waits, for the approver the business names for the amount's band,
 * in the app only, signed in, for five minutes.
 */
export const FinalLevel = defineApprovalLevel({
  name: 'fixture_final',
  rank: 3,
  label: label('Final'),
  policy: {
    approver: { by: { band: 'payments' }, channels: ['app'], minAssurance: 'session' },
    expiresInMs: 5 * 60_000,
  },
});

/** A band's approver may be anyone holding this: admins, by default. */
export const ApprovePayments = defineCapability({
  name: 'fixture.payments.approve',
  label: label('Approve payments'),
  roles: ['admin'],
});

export const Payment = z.object({
  id: z.string(),
  title: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  note: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

const title = z.string().min(1).max(200);
export const PaymentSpec = entitySpec({
  name: 'payment',
  label: 'payment',
  description: 'Payments: a title, an amount in minor units and its currency, and a note.',
  schemas: {
    read: Payment,
    create: z.object({
      title,
      amountMinor: z.number().int().min(0),
      currency: z.string().regex(/^[A-Z]{3}$/),
      note: z.string().optional(),
    }),
    update: z.object({
      title: title.optional(),
      amountMinor: z.number().int().min(0).optional(),
      note: z.string().nullable().optional(),
    }),
  },
  list: {
    filterable: {},
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
});

const ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const PaymentDef = defineEntity(PaymentSpec, {
  table: levelPayments,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

/** payment.sent: what the send command did. */
export class PaymentSent implements NamedEvent {
  readonly eventName = 'payment.sent';
  constructor(readonly row: unknown) {}
}

export const SendPaymentSpec = commandSpec({
  name: 'payment.send',
  description: 'Send a payment advice to the party outside the business.',
  input: z.object({ paymentId: z.uuid() }),
  output: z.object({ sent: z.literal(true) }),
  http: { method: 'POST', path: '/api/payments/:paymentId/send' },
  expose: 'all',
  touches: [],
});

export const SendPayment = defineCommand(SendPaymentSpec, {
  resource: { type: 'payment', id: (input) => input.paymentId },
  load: (tx, p, input) => PaymentDef.repo.get(tx, p, input.paymentId),
  authorize: () => allow('may_send'),
  summarize: (_input, payment) => `Send "${payment.title}" outside`,
  run: async ({ loaded }) => ({
    value: { sent: true as const },
    touched: [],
    events: [new PaymentSent({ id: loaded.id, tenantId: loaded.tenantId })],
  }),
});

const amountOf = (input: Record<string, unknown> | null, row: Record<string, unknown> | null) =>
  ({
    minor: Number(input?.amountMinor ?? row?.amountMinor ?? 0),
    currency: String(input?.currency ?? row?.currency ?? ''),
  }) satisfies Money;

/**
 * Which payment writes reach which level: above the business's `payments.limit` threshold (or
 * with none set) a write is final; within it, internal. Sending one goes outside.
 */
export const PaymentLevels = defineLevelRule({
  name: 'fixture.payments',
  on: ['payment.*'],
  decide: ({ op, input, row, settings }) => {
    if (op.name === 'payment.send')
      return atLevel(OutsideLevel.name, 'payment_goes_out', 'It goes to someone outside');
    if (op.name === 'payment.delete')
      return atLevel(InternalLevel.name, 'payment_removed', 'Removing one is internal');
    const amount = amountOf(input, row);
    return overThreshold(settings, 'payments.limit', amount)
      ? atLevel(FinalLevel.name, 'payment_over_limit', 'Above the business limit', { amount })
      : atLevel(InternalLevel.name, 'payment_within_limit', 'Within the business limit', {
          amount,
        });
  },
});

/** Staff never see a payment's note: not in a read, a write result, nor an approval card. */
export const notesHidden: ReadProjector = {
  name: 'fixture.payment-notes',
  project: (type, value, p) => {
    if (type !== 'payment' || !p.roles?.includes('staff')) return value;
    const { note: _note, ...rest } = value;
    return rest;
  },
};

@Module({
  controllers: [entityController(PaymentDef), commandController(SendPayment)],
  providers: [...entityHandlers(PaymentDef), commandHandler(SendPayment)],
})
export class PaymentsModule {}

export const paymentsModule = defineModule({
  ...moduleSpec({
    name: 'payments',
    entities: { payments: PaymentSpec },
    commands: [SendPaymentSpec],
  }),
  server: PaymentsModule,
});

export const approvalLevelsContributions: Partial<Contributions> = {
  approvalLevels: [LookLevel, InternalLevel, OutsideLevel, FinalLevel],
  capabilities: [ApprovePayments],
  levelRules: [PaymentLevels],
  readProjectors: [notesHidden],
};

/** The fixture plus payments, served with its levels, level rule and projector. */
export const approvalLevelsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, paymentsModule],
  contributes: approvalLevelsContributions,
});
