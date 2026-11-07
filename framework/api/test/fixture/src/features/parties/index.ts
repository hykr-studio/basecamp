// Parties and participants as an application uses them (B7): a `cases` module whose cases people
// outside the team participate in, in participant roles the application declares (a client who may
// change the case, an observer who only reads it, a partner organisation), notes that follow their
// case's participations, a budget only some capabilities read, and a notification to everyone on a
// case. Only the parties tests' servers (`partiesServer`, `noBusinessServer`) add the module.
import { defineModule, defineServer } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  defineCapability,
  defineParticipantRole,
  entitySpec,
  moduleSpec,
} from '@hykr/contracts';
import { defineEntity, entityController, entityHandlers } from '@hykr/core';
import { defineNotification, type Row } from '@hykr/notifications';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { caseNotes, cases } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);
const budget = z.number().int().min(0);

export const Case = z.object({
  id: z.string(),
  title,
  // Optional: removed for whoever may not read it.
  budget: budget.nullable().optional(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const CaseSpec = entitySpec({
  name: 'case',
  label: 'case',
  description: 'Cases: a title and a budget.',
  schemas: {
    read: Case,
    create: z.object({ title, budget: budget.optional() }),
    update: z.object({ title: title.optional(), budget: budget.nullable().optional() }),
  },
  fieldLabels: { budget: label('Budget') },
  list: {
    filterable: { title: 'text', budget: 'number' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
  },
  // The assistant's changes wait for the person they are for.
  approval: { update: (p) => p.actor.kind === 'agent' },
  traits: { fieldPolicy: { budget: 'fixture.budget.read' } },
});

export const CaseNote = z.object({
  id: z.string(),
  caseId: z.string(),
  text: z.string(),
  createdAt: z.iso.datetime(),
});

export const CaseNoteSpec = entitySpec({
  name: 'caseNote',
  label: 'case note',
  description: "A case's notes.",
  schemas: {
    read: CaseNote,
    create: z.object({ caseId: z.uuid(), text: z.string().min(1).max(500) }),
    update: z.object({ text: z.string().min(1).max(500).optional() }),
  },
  list: {
    filterable: { caseId: 'id' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
});

export const casesSpec = moduleSpec({
  name: 'cases',
  entities: { cases: CaseSpec, caseNotes: CaseNoteSpec },
  commands: [],
});

/** A person who may change the case they are on. */
export const ClientRole = defineParticipantRole({
  name: 'fixture_client',
  label: label('Client'),
  kinds: ['person'],
  on: ['case'],
});
/** Reads the case, changes nothing. */
export const ObserverRole = defineParticipantRole({
  name: 'fixture_observer',
  label: label('Observer'),
  on: ['case'],
});
/** An outside organisation on a case: reads it. */
export const PartnerRole = defineParticipantRole({
  name: 'fixture_partner',
  label: label('Partner'),
  kinds: ['organisation'],
  on: ['case'],
});

/**
 * The team as usual; anyone outside it (a contact, a participant: the `customer` role) their own
 * customer's cases and the cases their parties are on, changing only those they are a client of.
 */
const CASE_ACCESS: Access = {
  read: {
    owner: 'tenant',
    admin: 'tenant',
    ops: 'tenant',
    staff: 'own',
    customer: ['customer', { grant: 'participant' }],
  },
  write: {
    owner: 'tenant',
    admin: 'tenant',
    ops: 'tenant',
    staff: 'own',
    customer: ['customer', { grant: 'participant', as: ['fixture_client'] }],
  },
};

/** A note follows its case: participants read them; a client adds them. */
const NOTE_ACCESS: Access = {
  read: {
    owner: 'tenant',
    admin: 'tenant',
    customer: { grant: 'participant', of: 'case', via: 'caseId' },
  },
  write: {
    owner: 'tenant',
    admin: 'tenant',
    customer: { grant: 'participant', of: 'case', via: 'caseId', as: ['fixture_client'] },
  },
};

export const CaseDef = defineEntity(CaseSpec, {
  table: cases,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: CASE_ACCESS,
});

export const CaseNoteDef = defineEntity(CaseNoteSpec, {
  table: caseNotes,
  owner: (t) => t.ownerId,
  access: NOTE_ACCESS,
});

/** Everyone on a case hears when it changes: its clients and observers, not its partners. */
export const CaseChanged = defineNotification<Row & { title: string; updatedAt: string }>({
  key: 'case.changed',
  topic: 'service',
  send: { on: ['case.updated'] },
  to: (c) => [
    { participantsOf: { type: 'case', id: c.id }, as: ['fixture_client', 'fixture_observer'] },
  ],
  channels: ['email'],
  email: {
    subject: (c) => `Case changed: ${c.title}`,
    body: (c) => `${c.title} changed.`,
  },
  dedupe: (c) => `case-changed:${c.id}:${c.updatedAt}`,
});

@Module({
  controllers: [entityController(CaseDef), entityController(CaseNoteDef)],
  providers: [...entityHandlers(CaseDef), ...entityHandlers(CaseNoteDef)],
})
class CasesModule {}

export const casesModule = defineModule({
  ...casesSpec,
  server: CasesModule,
  notifications: [CaseChanged],
  tables: { cases, caseNotes },
});

export const partiesContributions: Partial<Contributions> = {
  participantRoles: [ClientRole, ObserverRole, PartnerRole],
  capabilities: [
    defineCapability({
      name: 'fixture.budget.read',
      label: label('See budgets'),
      roles: ['owner', 'admin'],
    }),
  ],
};

/** The fixture with the cases module and the participant roles. */
export const partiesServer = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, casesModule],
  contributes: partiesContributions,
});

/** The same, where signing up gives a person no business of their own. */
export const noBusinessServer = defineServer({
  ...partiesServer.definition,
  signUp: { createBusiness: false },
});
