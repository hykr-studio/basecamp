// Summaries (B14), on neutral data: an `entries` module whose entries have a state, a flag,
// money, a number, a timestamp and a date, a margin only one capability reads (field policy)
// and units a read projector hides from staff. Over the same table, `tallies` are listed by
// people only and `ledgers` by no one (an internal list, so no summary route). A scripted turn
// asks for entries by state through `summarize-entries`. Only the summary test boots this
// server (`summaryServer`).
import { defineModule, defineServer } from '@hykr/api';
import { type AgentModule, call, defineScript, say } from '@hykr/agents/script';
import {
  type Contributions,
  CreatedBy,
  CurrencyCode,
  defineCapability,
  entitySpec,
  Money,
  MoneyInput,
  moduleSpec,
} from '@hykr/contracts';
import { defineEntity, entityController, entityHandlers, type ReadProjector } from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { entries } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);
const state = z.enum(['draft', 'done', 'void']);

export const Entry = z.object({
  id: z.string(),
  title,
  state,
  flagged: z.boolean(),
  currency: CurrencyCode,
  amount: Money,
  units: z.number().int().optional(),
  // Optional: removed for whoever may not read it.
  margin: z.number().int().nullable().optional(),
  bookedAt: z.iso.datetime().nullable(),
  dueOn: z.iso.date().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

const fields = {
  title,
  state: state.optional(),
  flagged: z.boolean().optional(),
  currency: CurrencyCode.optional(),
  amount: MoneyInput.optional(),
  units: z.number().int().min(0).optional(),
  margin: z.number().int().nullable().optional(),
  bookedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  dueOn: z.iso.date().nullable().optional(),
};

const list = {
  filterable: {
    state: 'enum',
    flagged: 'boolean',
    title: 'text',
    amount: 'money',
    units: 'number',
    margin: 'number',
    bookedAt: 'date',
    dueOn: 'date',
  },
  sortable: ['createdAt'],
  defaultSort: [['createdAt', 'asc']],
  search: ['title'],
  pageSize: { default: 50, max: 100 },
} as const satisfies Parameters<typeof entitySpec>[0]['list'];

const traits = {
  money: { fields: ['amount'] },
  fieldPolicy: { margin: 'fixture.margin.read' },
};

export const EntrySpec = entitySpec({
  name: 'entry',
  plural: 'entries',
  label: 'entry',
  description: 'Entries: a title, a state, an amount, units and a margin.',
  schemas: {
    read: Entry,
    create: z.object(fields),
    update: z.object({ ...fields, title: title.optional() }),
  },
  fieldLabels: { margin: label('Margin'), units: label('Units'), amount: label('Amount') },
  list,
  traits,
});

/** The same records, listed (and summarized) by people only. */
export const TallySpec = entitySpec({
  name: 'tally',
  plural: 'tallies',
  label: 'tally',
  description: 'Tallies: entries people count; the assistant does not.',
  schemas: EntrySpec.schemas,
  list,
  traits,
  expose: { list: 'human', get: 'human', create: 'human', update: 'human', delete: 'human' },
});

/** The same records, listed and read by no one: only server code reads them, so no summary route. */
export const LedgerSpec = entitySpec({
  name: 'ledger',
  label: 'ledger',
  description: 'Ledgers: entries only server code lists.',
  schemas: EntrySpec.schemas,
  list,
  traits,
  expose: {
    list: 'internal',
    get: 'internal',
    create: 'internal',
    update: 'internal',
    delete: 'internal',
  },
});

const ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const EntryDef = defineEntity(EntrySpec, {
  table: entries,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});
export const TallyDef = defineEntity(TallySpec, {
  table: entries,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});
export const LedgerDef = defineEntity(LedgerSpec, {
  table: entries,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

@Module({
  controllers: [entityController(EntryDef), entityController(TallyDef), entityController(LedgerDef)],
  providers: [...entityHandlers(EntryDef), ...entityHandlers(TallyDef), ...entityHandlers(LedgerDef)],
})
export class EntriesModule {}

type Counted = { totals?: { count: number }[] };

/** "count entries by state": the summary tool, then one line; the tiles carry the numbers. */
export const entriesAgent: AgentModule = {
  help: 'I can count entries.',
  scripts: [
    defineScript({
      name: 'count-entries',
      match: (text) => (/^count entries by state$/i.test(text.trim()) ? true : undefined),
      step: (_m, turn) => {
        const r = turn.result('summarize-entries');
        if (!r) return [call('summarize-entries', { groupBy: ['state'], sort: '-count' })];
        const total = r.ok ? (r.result as Counted).totals?.[0]?.count : undefined;
        return [say(total === undefined ? 'I could not count them.' : `${total} entries in all.`)];
      },
    }),
  ],
};

export const entriesModule = defineModule({
  ...moduleSpec({
    name: 'entries',
    entities: { entries: EntrySpec, tallies: TallySpec, ledgers: LedgerSpec },
    commands: [],
  }),
  server: EntriesModule,
  agent: entriesAgent,
  tables: { entries },
});

/** Staff never see an entry's units, wherever one leaves the server (a projector, not a policy). */
export const unitsFromStaff: ReadProjector = {
  name: 'fixture.summary-units',
  project: (type, value, p) => {
    if (!['entry', 'tally'].includes(type) || !p.roles?.includes('staff')) return value;
    const { units: _hidden, ...rest } = value;
    return rest;
  },
};

export const summaryContributions: Partial<Contributions> = {
  capabilities: [
    defineCapability({
      name: 'fixture.margin.read',
      label: label('See margins'),
      roles: ['owner', 'admin'],
    }),
  ],
  readProjectors: [unitsFromStaff],
};

/** The fixture plus entries. */
export const summaryServer = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, entriesModule],
  contributes: summaryContributions,
});
