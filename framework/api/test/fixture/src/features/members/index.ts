// Roles, grants and field policy as an application uses them (A4): its own roles and
// capabilities, an override of a framework role, the roles handed to a creator and a contact,
// a `projects` module whose `cost` only some capabilities read, rows reached through record grants
// (a project, and its steps through `via`) and through a capability key, a command whose output
// hides the cost too, a notification whose words name the cost (H1), and requests decided by
// someone outside the team (H1). Only the members test's server (`membersServer`) adds the module.
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
  needsApproval,
} from '@hykr/core';
import { defineNotification, type Row } from '@hykr/notifications';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { projectSteps, projects } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);
const cost = z.number().int().min(0);

export const Project = z.object({
  id: z.string(),
  title,
  // Optional: removed for whoever may not read it.
  cost: cost.nullable().optional(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

/** Deciding the assistant's changes to a project: owners and crew, who do not read the cost. */
export const ApproveProjects = defineCapability({
  name: 'fixture.projects.approve',
  label: label('Approve project changes'),
  roles: ['owner', 'fixture_crew'],
});

export const ProjectSpec = entitySpec({
  name: 'project',
  label: 'project',
  description: 'Projects: a title and what it costs.',
  schemas: {
    read: Project,
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
  // The assistant's changes wait for an owner or a crew member; its deletes for the default
  // decider (the person, unless they are outside the team).
  approval: {
    update: { when: (p) => p.actor.kind === 'agent', by: { capability: ApproveProjects.name } },
    delete: (p) => p.actor.kind === 'agent',
  },
  traits: { fieldPolicy: { cost: { read: 'fixture.cost.read', write: 'fixture.cost.write' } } },
});

export const Step = z.object({
  id: z.string(),
  projectId: z.string(),
  title,
  createdAt: z.iso.datetime(),
});

export const StepSpec = entitySpec({
  name: 'step',
  label: 'step',
  description: "A project's steps.",
  schemas: {
    read: Step,
    create: z.object({ projectId: z.uuid(), title }),
    update: z.object({ title: title.optional() }),
  },
  list: {
    filterable: { projectId: 'id' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
});

export const RepriceProjectSpec = commandSpec({
  name: 'project.reprice',
  description: 'Set what a project costs.',
  input: z.object({ projectId: z.uuid(), cost }),
  // Not the entity's read schema: the command's own policy hides the cost.
  output: z.object({ projectId: z.string(), title, cost: cost.nullable().optional() }),
  http: { method: 'POST', path: '/api/projects/:projectId/reprice' },
  expose: 'all',
  touches: ['project'],
  traits: { fieldPolicy: { cost: 'fixture.cost.read' } },
});

/** Ask a named person to look a project over: they decide alone (if they may). */
export const ReviewProjectSpec = commandSpec({
  name: 'project.review',
  description: 'Ask a named person to review a project.',
  input: z.object({ projectId: z.uuid(), reviewerId: z.string().min(1) }),
  output: z.object({ reviewed: z.literal(true) }),
  http: { method: 'POST', path: '/api/projects/:projectId/review' },
  expose: 'all',
  touches: [],
});

export const projectsSpec = moduleSpec({
  name: 'projects',
  entities: { projects: ProjectSpec, steps: StepSpec },
  commands: [RepriceProjectSpec, ReviewProjectSpec],
});

/**
 * Owners and admins every project; crew their own and the projects granted to them; a capability key
 * every project.
 */
const PROJECT_ACCESS: Access = {
  read: {
    owner: 'tenant',
    admin: 'tenant',
    staff: 'own',
    fixture_crew: ['own', { grant: 'granted' }],
    fixture_estimator: 'tenant',
    fixture_client: 'own',
    'fixture.projects.all': 'tenant',
  },
  write: {
    owner: 'tenant',
    admin: 'tenant',
    staff: 'own',
    fixture_crew: ['own', { grant: 'granted' }],
    fixture_estimator: 'tenant',
    fixture_client: 'own',
    'fixture.projects.all': 'tenant',
  },
};

/**
 * A step follows its project: crew reach the steps of projects granted to them, and add steps there.
 * Not 'own': with it, anyone could add a step to a project they cannot see.
 */
const STEP_ACCESS: Access = {
  read: {
    owner: 'tenant',
    admin: 'tenant',
    fixture_crew: { grant: 'granted', of: 'project', via: 'projectId' },
  },
  write: {
    owner: 'tenant',
    admin: 'tenant',
    fixture_crew: { grant: 'granted', of: 'project', via: 'projectId' },
  },
};

export const ProjectDef = defineEntity(ProjectSpec, {
  table: projects,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: PROJECT_ACCESS,
});

export const StepDef = defineEntity(StepSpec, {
  table: projectSteps,
  owner: (t) => t.ownerId,
  access: STEP_ACCESS,
});

export const RepriceProject = defineCommand(RepriceProjectSpec, {
  resource: { type: 'project', id: (input) => input.projectId },
  load: (tx, p, input) => ProjectDef.repo.get(tx, p, input.projectId),
  authorize: () => allow('reprice'),
  summarize: (input) => `Set the cost to ${input.cost}`,
  run: async ({ tx, principal, input, loaded, via }) => {
    const after = await ProjectDef.repo.update(tx, principal, loaded, { cost: input.cost }, via);
    return {
      value: { projectId: after.id, title: after.title, cost: after.cost },
      touched: [{ type: 'project', id: after.id, change: 'updated', before: loaded, after }],
    };
  },
});

export const ReviewProject = defineCommand(ReviewProjectSpec, {
  resource: { type: 'project', id: (input) => input.projectId },
  load: (tx, p, input) => ProjectDef.repo.get(tx, p, input.projectId),
  authorize: (_p, _project, input) =>
    needsApproval('review', 'The named reviewer decides', {
      approver: { by: { userId: input.reviewerId } },
    }),
  summarize: (_input, project) => `Review "${project.title}"`,
  run: async () => ({ value: { reviewed: true as const }, touched: [] }),
});

/** Hears of a new project: its words name the cost, which only some of them may read. */
export const HearProjects = defineCapability({
  name: 'fixture.projects.hear',
  label: label('Hear of new projects'),
  roles: ['owner', 'fixture_estimator'],
});

type ProjectRow = Row & { title: string; cost?: number | null; ownerId: string };

/** A new project told to whoever hears of them; the cost only to those who may read it. */
export const ProjectToldNotification = defineNotification<ProjectRow>({
  key: 'fixture.project-told',
  topic: 'service',
  send: { on: ['project.created'] },
  when: (p) => p.title.startsWith('Told'),
  to: () => [{ capability: HearProjects.name }],
  channels: ['email'],
  also: ['inapp'],
  email: {
    subject: (p) => `New project ${p.title}`,
    body: (p) => `${p.title}: cost ${p.cost ?? 'not shown'} (owner ${p.ownerId ?? 'not shown'})`,
  },
  inapp: {
    title: (p) => `New project ${p.title}`,
    body: (p) => `cost ${p.cost ?? 'not shown'}`,
    record: (p) => ({ type: 'project', id: p.id }),
  },
  dedupe: (p) => `fixture.project-told:${p.id}`,
});

@Module({
  controllers: [
    entityController(ProjectDef),
    entityController(StepDef),
    commandController(RepriceProject),
    commandController(ReviewProject),
  ],
  providers: [
    ...entityHandlers(ProjectDef),
    ...entityHandlers(StepDef),
    commandHandler(RepriceProject),
    commandHandler(ReviewProject),
  ],
})
class ProjectsModule {}

export const projectsModule = defineModule({
  ...projectsSpec,
  server: ProjectsModule,
  notifications: [ProjectToldNotification],
  tables: { projects, projectSteps },
});

/** Crew: only the projects granted to them, and those projects' steps. Not the cost. */
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
    // Not given to any declared role: a business's own role reaches every project through it.
    defineCapability({ name: 'fixture.projects.all', label: label('Every project') }),
    ApproveProjects,
    HearProjects,
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

/** The fixture with the projects module and these contributions. */
export const membersServer = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, projectsModule],
  contributes: membersContributions,
});
