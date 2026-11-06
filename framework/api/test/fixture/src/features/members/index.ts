// Roles, grants and field policy as an application uses them (A4): its own roles and
// capabilities, an override of a framework role, the roles handed to a creator and a contact,
// a `jobs` module whose `cost` only some capabilities read, rows reached through record grants
// (a job, and its steps through `via`) and through a capability key, and a command whose output
// hides the cost too. Only the members test's server (`membersServer`) adds the module.
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
  commandController,
  commandHandler,
  defineCommand,
  defineEntity,
  entityController,
  entityHandlers,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { jobSteps, jobs } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);
const cost = z.number().int().min(0);

export const Job = z.object({
  id: z.string(),
  title,
  // Optional: removed for whoever may not read it.
  cost: cost.nullable().optional(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const JobSpec = entitySpec({
  name: 'job',
  label: 'job',
  description: 'Jobs: a title and what it costs.',
  schemas: {
    read: Job,
    create: z.object({ title, cost: cost.optional() }),
    update: z.object({ title: title.optional(), cost: cost.nullable().optional() }),
  },
  fieldLabels: { cost: label('Cost') },
  list: {
    filterable: { title: 'text', cost: 'number' },
    sortable: ['createdAt', 'cost'],
    defaultSort: [['createdAt', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
  },
  // The assistant's changes wait for an owner or a crew member.
  approval: { update: { when: (p) => p.actor.kind === 'agent', by: ['owner', 'fixture_crew'] } },
  traits: { fieldPolicy: { cost: { read: 'fixture.cost.read', write: 'fixture.cost.write' } } },
});

export const Step = z.object({
  id: z.string(),
  jobId: z.string(),
  title,
  createdAt: z.iso.datetime(),
});

export const StepSpec = entitySpec({
  name: 'step',
  label: 'step',
  description: "A job's steps.",
  schemas: {
    read: Step,
    create: z.object({ jobId: z.uuid(), title }),
    update: z.object({ title: title.optional() }),
  },
  list: {
    filterable: { jobId: 'id' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
});

export const RepriceJobSpec = commandSpec({
  name: 'job.reprice',
  description: 'Set what a job costs.',
  input: z.object({ jobId: z.uuid(), cost }),
  // Not the entity's read schema: the command's own policy hides the cost.
  output: z.object({ jobId: z.string(), title, cost: cost.nullable().optional() }),
  http: { method: 'POST', path: '/api/jobs/:jobId/reprice' },
  expose: 'all',
  touches: ['job'],
  traits: { fieldPolicy: { cost: 'fixture.cost.read' } },
});

export const jobsSpec = moduleSpec({
  name: 'jobs',
  entities: { jobs: JobSpec, steps: StepSpec },
  commands: [RepriceJobSpec],
});

/**
 * Owners and admins every job; crew their own and the jobs granted to them; a capability key
 * every job.
 */
const JOB_ACCESS: Access = {
  read: {
    owner: 'tenant',
    admin: 'tenant',
    staff: 'own',
    fixture_crew: ['own', { grant: 'granted' }],
    fixture_estimator: 'tenant',
    'fixture.jobs.all': 'tenant',
  },
  write: {
    owner: 'tenant',
    admin: 'tenant',
    staff: 'own',
    fixture_crew: ['own', { grant: 'granted' }],
    fixture_estimator: 'tenant',
    'fixture.jobs.all': 'tenant',
  },
};

/**
 * A step follows its job: crew reach the steps of jobs granted to them, and add steps there.
 * Not 'own': with it, anyone could add a step to a job they cannot see.
 */
const STEP_ACCESS: Access = {
  read: {
    owner: 'tenant',
    admin: 'tenant',
    fixture_crew: { grant: 'granted', of: 'job', via: 'jobId' },
  },
  write: {
    owner: 'tenant',
    admin: 'tenant',
    fixture_crew: { grant: 'granted', of: 'job', via: 'jobId' },
  },
};

export const JobDef = defineEntity(JobSpec, {
  table: jobs,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: JOB_ACCESS,
});

export const StepDef = defineEntity(StepSpec, {
  table: jobSteps,
  owner: (t) => t.ownerId,
  access: STEP_ACCESS,
});

export const RepriceJob = defineCommand(RepriceJobSpec, {
  resource: { type: 'job', id: (input) => input.jobId },
  load: (tx, p, input) => JobDef.repo.get(tx, p, input.jobId),
  authorize: () => allow('reprice'),
  summarize: (input) => `Set the cost to ${input.cost}`,
  run: async ({ tx, principal, input, loaded, via }) => {
    const after = await JobDef.repo.update(tx, principal, loaded, { cost: input.cost }, via);
    return {
      value: { jobId: after.id, title: after.title, cost: after.cost },
      touched: [{ type: 'job', id: after.id, change: 'updated', before: loaded, after }],
    };
  },
});

@Module({
  controllers: [entityController(JobDef), entityController(StepDef), commandController(RepriceJob)],
  providers: [...entityHandlers(JobDef), ...entityHandlers(StepDef), commandHandler(RepriceJob)],
})
class JobsModule {}

export const jobsModule = defineModule({
  ...jobsSpec,
  server: JobsModule,
  tables: { jobs, jobSteps },
});

/** Crew: only the jobs granted to them, and those jobs' steps. Not the cost. */
export const Crew = defineRole({ name: 'fixture_crew', label: label('Crew') });
/** Sets costs it cannot read. */
export const Estimator = defineRole({
  name: 'fixture_estimator',
  label: label('Estimator'),
  capabilities: ['fixture.cost.write'],
});
/** The client a WhatsApp contact is, in this application. */
export const Client = defineRole({ name: 'fixture_client', label: label('Client') });

export const membersContributions: Partial<Contributions> = {
  capabilities: [
    defineCapability({
      name: 'fixture.cost.read',
      label: label('See costs'),
      roles: ['owner', 'admin'],
    }),
    defineCapability({
      name: 'fixture.cost.write',
      label: label('Set costs'),
      roles: ['owner', 'admin'],
    }),
    // Not given to any declared role: a business's own role reaches every job through it.
    defineCapability({ name: 'fixture.jobs.all', label: label('Every job') }),
  ],
  roles: [Crew, Estimator, Client],
  // The application relabels the framework's staff and replaces what it may do.
  roleOverrides: [
    {
      role: 'staff',
      label: label('Team member'),
      capabilities: ['backoffice.use', 'members.read'],
    },
  ],
  // Whoever creates a business is its owner and an admin; a contact is a client.
  roleDefaults: [
    { name: 'creator', roles: ['owner', 'admin'] },
    { name: 'contact', roles: ['fixture_client'] },
  ],
};

/** The fixture with the jobs module and these contributions. */
export const membersServer = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, jobsModule],
  contributes: membersContributions,
});
