// Personal data (B18) as an application declares it: a `ledgers` module whose cards are a
// customer's personal data (deleted when they are forgotten, and after 30 days), whose ledger
// entries are kept for a legal hold, and whose callers (a customer's or a WhatsApp contact's)
// are anonymised; a processor, a policy (answer within 30 days), a period for relayed
// notifications, and a level rule that makes processing an erasure wait for an approval. Only
// the privacy e2e test boots `privacyApp`; its tables are a migration set of their own.
import { defineModule, definePrivacyPolicy, defineProcessor, defineServer } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  defineApprovalLevel,
  entitySpec,
  moduleSpec,
} from '@hykr/contracts';
import {
  atLevel,
  defineEntity,
  defineLevelRule,
  entityController,
  entityHandlers,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { callers, cards, ledgerEntries } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const text = z.string().min(1).max(200);
const dates = { createdBy: CreatedBy, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() };

export const CardSpec = entitySpec({
  name: 'card',
  label: 'card',
  description: 'Cards: a name, a phone and an amount.',
  schemas: {
    read: z.object({
      id: z.string(),
      name: text,
      phone: z.string().nullable(),
      amountMinor: z.number().int(),
      ...dates,
    }),
    create: z.object({
      name: text,
      phone: z.string().optional(),
      amountMinor: z.number().int().optional(),
    }),
    update: z.object({
      name: text.optional(),
      phone: z.string().nullable().optional(),
      amountMinor: z.number().int().optional(),
    }),
  },
  fieldLabels: { name: label('Name'), phone: label('Phone') },
  list: {
    filterable: { name: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  traits: {
    privacy: {
      subject: { customer: ['customerId'] },
      fields: ['name', 'phone'],
      erase: 'delete',
      retention: { name: 'ledgers.cards', days: 30, action: 'delete' },
      purpose: label('Cards the business keeps about its customers'),
    },
  },
});

export const LedgerEntrySpec = entitySpec({
  name: 'ledgerEntry',
  plural: 'ledgerEntries',
  label: 'ledger entry',
  description: 'Ledger entries: who paid, and how much.',
  schemas: {
    read: z.object({ id: z.string(), payer: text, amountMinor: z.number().int(), ...dates }),
    create: z.object({ payer: text, amountMinor: z.number().int().optional() }),
    update: z.object({ payer: text.optional(), amountMinor: z.number().int().optional() }),
  },
  list: {
    filterable: { payer: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  traits: {
    privacy: {
      subject: { customer: ['customerId'] },
      fields: ['payer'],
      erase: 'keep',
      keepReason: 'legal_hold',
    },
  },
});

export const CallerSpec = entitySpec({
  name: 'caller',
  label: 'caller',
  description: 'Callers: who called, and their number.',
  schemas: {
    read: z.object({
      id: z.string(),
      caller: text,
      phone: z.string().nullable(),
      contactId: z.string().nullable(),
      ...dates,
    }),
    create: z.object({
      caller: text,
      phone: z.string().optional(),
      contactId: z.string().optional(),
    }),
    update: z.object({ caller: text.optional(), phone: z.string().nullable().optional() }),
  },
  list: {
    filterable: { caller: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  traits: {
    privacy: {
      subject: { customer: ['customerId'], contact: ['contactId'] },
      fields: ['caller', 'phone'],
      erase: 'anonymise',
      replace: { caller: 'erased' },
    },
  },
});

/** The team reads everything; staff their own; a customer their own customer's. */
const ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const CardDef = defineEntity(CardSpec, {
  table: cards,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});
export const LedgerEntryDef = defineEntity(LedgerEntrySpec, {
  table: ledgerEntries,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});
export const CallerDef = defineEntity(CallerSpec, {
  table: callers,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

@Module({
  controllers: [
    entityController(CardDef),
    entityController(LedgerEntryDef),
    entityController(CallerDef),
  ],
  providers: [
    ...entityHandlers(CardDef),
    ...entityHandlers(LedgerEntryDef),
    ...entityHandlers(CallerDef),
  ],
})
export class LedgersFixtureModule {}

export const ledgersModule = defineModule({
  ...moduleSpec({
    name: 'ledgers',
    dependsOn: [],
    entities: { cards: CardSpec, ledgerEntries: LedgerEntrySpec, callers: CallerSpec },
    commands: [],
  }),
  server: LedgersFixtureModule,
  tables: { cards, ledgerEntries, callers },
});

/** Cannot be taken back: waits for someone holding approvals.decide (never the requester). */
export const ForgetLevel = defineApprovalLevel({
  name: 'fixture_forget',
  rank: 3,
  label: label('Forget'),
  policy: { approver: { by: { capability: 'approvals.decide' } } },
});

/** Processing an erasure someone reviewed waits for a second person. */
export const ForgetWaits = defineLevelRule({
  name: 'fixture.privacy',
  on: ['privacy.process'],
  decide: ({ loaded }) =>
    (loaded as { kind?: string }).kind === 'erase'
      ? atLevel(ForgetLevel.name, 'erasure_waits', 'Forgetting a person cannot be undone')
      : null,
});

export const privacyContributions: Partial<Contributions> = {
  processors: [
    defineProcessor({
      name: 'Fixture mail',
      purpose: label('Sends the business email'),
      data: ['email address'],
      location: 'Test region',
    }),
  ],
  privacyPolicies: [definePrivacyPolicy({ name: 'fixture', respondWithinDays: 30 })],
  retentionPeriods: [{ target: 'outbox.relayed', days: 1 }],
  approvalLevels: [ForgetLevel],
  levelRules: [ForgetWaits],
};

/** The fixture, with everything above. */
export const privacyApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, ledgersModule],
  contributes: privacyContributions,
});
