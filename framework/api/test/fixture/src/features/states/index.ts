// State machines, SLAs, versions and revisions (B6, B4), on neutral data: a `tickets` module
// whose tickets move open → active → resolved → closed (or are cancelled), carry SLAs on open
// and active, a version per write, revisions in a series, and a tree of steps that freezes with
// the ticket. Only the states, sla and versions tests boot this server (`statesServer`).
import { defineModule, defineServer } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  commandSpec,
  defineCapability,
  defineRole,
  entitySpec,
  moduleSpec,
} from '@hykr/contracts';
import {
  allow,
  type ChildNode,
  commandController,
  commandHandler,
  defineChildEntity,
  defineCommand,
  defineEntity,
  deny,
  entityController,
  entityHandlers,
  needsApproval,
  type ReadProjector,
  reviseWithChildren,
  transition,
} from '@hykr/core';
import { type Access, can } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { ticketSteps, tickets } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);
const STATUS = [
  'open',
  'active',
  'resolved',
  'closed',
  'escalated',
  'cancelled',
  'superseded',
] as const;

export const Ticket = z.object({
  id: z.string(),
  title,
  status: z.enum(STATUS),
  resolution: z.string().nullable(),
  // Optional: removed for whoever may not read it.
  note: z.string().nullable().optional(),
  version: z.number().int(),
  seriesId: z.string().nullable(),
  revision: z.number().int(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

/** A title starting "[hold]" holds a ticket where it is: it resolves and escalates no further. */
const held = (row: Readonly<Record<string, unknown>>) =>
  String(row.title ?? '').startsWith('[hold]')
    ? { rule: 'ticket_on_hold', reason: 'This ticket is on hold' }
    : null;

export const TicketSpec = entitySpec({
  name: 'ticket',
  label: 'ticket',
  description: 'Tickets: a title, a state, a resolution once resolved.',
  schemas: {
    read: Ticket,
    create: z.object({
      title,
      note: z.string().max(500).optional(),
      status: z.string().optional(),
    }),
    update: z.object({
      title: title.optional(),
      note: z.string().max(500).nullable().optional(),
      status: z.enum(STATUS).optional(),
      resolution: z.string().max(500).nullable().optional(),
      version: z.number().int().optional(),
    }),
  },
  list: {
    filterable: { status: 'enum', title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
  },
  // The assistant's edits wait for the person: a parked edit is pinned to the version it saw.
  approval: { update: (p) => p.actor.kind === 'agent', delete: (p) => p.actor.kind === 'agent' },
  traits: {
    states: {
      field: 'status',
      initial: 'open',
      states: {
        open: { label: label('Open') },
        active: { label: label('In progress') },
        resolved: { label: label('Resolved') },
        closed: { label: label('Closed'), terminal: true },
        escalated: { label: label('Escalated') },
        cancelled: { label: label('Cancelled'), terminal: true },
        superseded: { label: label('Superseded'), terminal: true },
      },
      transitions: [
        { name: 'start', from: 'open', to: 'active', label: label('Start') },
        {
          name: 'resolve',
          from: ['open', 'active', 'escalated'],
          to: 'resolved',
          requires: ['resolution'],
          fields: ['resolution', 'note'],
          guard: held,
        },
        { name: 'reopen', from: 'resolved', to: 'open', expose: 'human' },
        {
          name: 'close',
          from: 'resolved',
          to: 'closed',
          can: 'fixture.tickets.close',
          approval: { when: (p) => p.actor.kind === 'agent', by: ['owner'] },
          tier: 3,
        },
        {
          name: 'cancel',
          from: ['open', 'active'],
          to: 'cancelled',
          approval: (p) => p.actor.kind === 'agent',
          tier: 2,
          event: 'ticket.dropped',
        },
        { name: 'escalate', from: 'open', to: 'escalated', expose: 'system', guard: held },
        { name: 'supersede', from: 'resolved', to: 'superseded', expose: 'system' },
      ],
      slas: [
        {
          name: 'fixture.tickets.respond',
          state: 'open',
          within: '2h',
          hours: 'business',
          escalate: { roles: ['owner'] },
        },
        {
          name: 'fixture.tickets.escalate',
          state: 'open',
          within: '48h',
          escalate: { transition: 'escalate' },
        },
        { name: 'fixture.tickets.work', state: 'active', within: '30m' },
      ],
    },
    versioned: {
      frozenWhen: { status: ['resolved', 'closed', 'cancelled', 'superseded'] },
      editableWhenFrozen: ['note'],
      revisions: {},
    },
  },
});

export const Step = z.object({
  id: z.string(),
  ticketId: z.string(),
  parentStepId: z.string().nullable(),
  position: z.number().int(),
  title,
  createdAt: z.iso.datetime(),
});

export const StepSpec = entitySpec({
  name: 'ticketStep',
  label: 'ticket step',
  description: "A ticket's steps, in a tree.",
  schemas: {
    read: Step,
    create: z.object({ title }),
    update: z.object({
      title: title.optional(),
      parentStepId: z.string().nullable().optional(),
      position: z.number().int().min(0).optional(),
    }),
  },
  list: {
    filterable: { ticketId: 'id' },
    sortable: ['position'],
    defaultSort: [['position', 'asc']],
    pageSize: { default: 100, max: 1000 },
  },
  traits: {
    parent: { entity: 'ticket', field: 'ticketId', nest: 'parentStepId', position: 'position' },
  },
});

const StepInput = z.object({
  ref: z.string().min(1).max(40),
  parent: z.string().min(1).max(40).optional(),
  title,
});

export const PlanTicketSpec = commandSpec({
  name: 'ticket.plan',
  description: "Set a ticket's steps, a whole tree at once.",
  input: z.object({ ticketId: z.uuid(), steps: z.array(StepInput).max(200) }),
  output: z.object({ ticket: Ticket, steps: z.array(Step) }),
  http: { method: 'POST', path: '/api/tickets/:ticketId/plan' },
  expose: 'all',
  touches: ['ticket', 'ticketStep'],
});

export const ReviseTicketSpec = commandSpec({
  name: 'ticket.revise',
  description:
    'Make the next revision of a resolved ticket, with its steps; the old one is superseded.',
  input: z.object({ ticketId: z.uuid() }),
  output: z.object({ ticket: Ticket, steps: z.array(Step) }),
  http: { method: 'POST', path: '/api/tickets/:ticketId/revise' },
  expose: 'all',
  touches: ['ticket', 'ticketStep'],
});

export const ticketsSpec = moduleSpec({
  name: 'tickets',
  entities: { tickets: TicketSpec, ticketSteps: StepSpec },
  commands: [PlanTicketSpec, ReviseTicketSpec],
});

/** Viewers read every ticket and write none. */
const ACCESS: Access = {
  read: {
    owner: 'tenant',
    admin: 'tenant',
    ops: 'tenant',
    staff: 'own',
    customer: 'customer',
    fixture_viewer: 'tenant',
  },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const TicketDef = defineEntity(TicketSpec, {
  table: tickets,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

export const StepDef = defineChildEntity(StepSpec, {
  table: ticketSteps,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
  parent: { def: TicketDef, owner: (t) => t.ownerId, customer: (t) => t.customerId },
});

type StepIn = z.infer<typeof StepInput>;

/** The flat steps as a tree of child nodes. */
function tree(steps: readonly StepIn[], under?: string): ChildNode[] {
  return steps
    .filter((s) => s.parent === under)
    .map((s) => ({ title: s.title, children: tree(steps, s.ref) }));
}

type TicketRow = typeof tickets.$inferSelect;
type StepRow = typeof ticketSteps.$inferSelect;
const shown = (
  v: { ticket: TicketRow; steps: StepRow[] },
  p: Parameters<typeof TicketDef.toRead>[1],
) => ({
  ticket: TicketDef.toRead(v.ticket, p),
  steps: v.steps.map((s) => StepDef.toRead(s, p)),
});

/** Set a ticket's steps: the assistant's plan waits (level 2), pinned to the ticket's version. */
export const PlanTicket = defineCommand(PlanTicketSpec, {
  resource: { type: 'ticket', id: (input) => input.ticketId },
  load: (tx, p, input) => TicketDef.repo.get(tx, p, input.ticketId),
  pin: (ticket) => [{ def: TicketDef, row: ticket }],
  authorize: (p) =>
    p.actor.kind === 'agent'
      ? needsApproval('agent_plans', 'A plan by the assistant waits for you', { tier: 2 })
      : allow('person_plans'),
  summarize: (input, ticket) => `Plan "${ticket.title}": ${input.steps.length} steps`,
  run: async ({ tx, principal, input, loaded, via }) => {
    const steps = await StepDef.children.replace(tx, principal, loaded, tree(input.steps), via);
    return { value: { ticket: loaded, steps: steps.rows }, touched: steps.touched };
  },
  present: shown,
});

/**
 * The next revision of a resolved ticket: a copy with its steps, open again; the old one is
 * superseded (frozen). The assistant's revise waits (level 2).
 */
export const ReviseTicket = defineCommand(ReviseTicketSpec, {
  resource: { type: 'ticket', id: (input) => input.ticketId },
  load: (tx, p, input) => TicketDef.repo.get(tx, p, input.ticketId),
  pin: (ticket) => [{ def: TicketDef, row: ticket }],
  authorize: (p, ticket) => {
    if (ticket.status !== 'resolved')
      return deny('revise_resolved_only', 'Only a resolved ticket is revised');
    return p.actor.kind === 'agent'
      ? needsApproval('agent_revises', 'A revision by the assistant waits for you', { tier: 2 })
      : allow('person_revises');
  },
  summarize: (_input, ticket) => `Revise "${ticket.title}" (v${ticket.revision})`,
  run: async ({ tx, principal, loaded, via }) => {
    const next = await reviseWithChildren(tx, principal, TicketDef, loaded, { via });
    const old = await transition(tx, principal, TicketDef, loaded, 'supersede', { via });
    return {
      value: {
        ticket: next.row as TicketRow,
        steps: (next.children.ticketStep ?? []) as StepRow[],
      },
      touched: [...next.touched, ...old.touched],
      events: old.events,
    };
  },
  present: shown,
});

@Module({
  controllers: [
    commandController(PlanTicket),
    commandController(ReviseTicket),
    entityController(TicketDef),
    entityController(StepDef),
  ],
  providers: [
    ...entityHandlers(TicketDef),
    ...entityHandlers(StepDef),
    commandHandler(PlanTicket),
    commandHandler(ReviseTicket),
  ],
})
class TicketsModule {}

export const ticketsModule = defineModule({
  ...ticketsSpec,
  server: TicketsModule,
  tables: { tickets, ticketSteps },
});

/**
 * A ticket's note is read only with fixture.tickets.notes: removed wherever a ticket leaves the
 * server (reads, transition results, versions, a parked edit's or move's input on its card).
 */
export const notesHidden: ReadProjector = {
  name: 'fixture.tickets.notes-hidden',
  project: (type, value, p) => {
    if (type !== 'ticket' || can(p, 'fixture.tickets.notes')) return value;
    const { note: _note, ...rest } = value;
    return rest;
  },
};

/** Reads every ticket, writes none. */
export const Viewer = defineRole({ name: 'fixture_viewer', label: label('Viewer') });

export const statesContributions: Partial<Contributions> = {
  capabilities: [
    defineCapability({
      name: 'fixture.tickets.close',
      label: label('Close tickets'),
      roles: ['owner', 'admin'],
    }),
    defineCapability({
      name: 'fixture.tickets.notes',
      label: label("Read tickets' notes"),
      roles: ['owner', 'admin'],
    }),
  ],
  roles: [Viewer],
  readProjectors: [notesHidden],
};

/** The fixture with the tickets module. */
export const statesServer = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, ticketsModule],
  contributes: statesContributions,
});
