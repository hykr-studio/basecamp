// The platform tier as an application uses it (B19): an `issues` module (what a routed request
// becomes in the business that takes it; a note only some capabilities read; a support person's
// delete waits for the business), a `parts` module the platform shares with every business and
// only its operators publish, and the application's router: a request carrying `#<code>` goes to
// the business the test gave that code. The routing rule is the fixture's, not the framework's.
import { defineInboundRouter, defineModule, defineServer } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  commandSpec,
  defineCapability,
  defineFeatureFlag,
  defineShareable,
  entitySpec,
  moduleSpec,
  SharedFields,
  SharedFromInput,
} from '@hykr/contracts';
import {
  allow,
  commandController,
  commandHandler,
  defineCommand,
  defineEntity,
  defineSharedEntity,
  deny,
  entityController,
  entityHandlers,
  entityOp,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { issues, parts } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);

export const Issue = z.object({
  id: z.string(),
  title,
  // Optional: removed for whoever may not read it.
  note: z.string().nullable().optional(),
  customerId: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const IssueSpec = entitySpec({
  name: 'issue',
  label: 'issue',
  description: 'Issues: a title and a note.',
  schemas: {
    read: Issue,
    create: z.object({ title, note: z.string().max(500).optional() }),
    update: z.object({ title: title.optional(), note: z.string().max(500).nullable().optional() }),
  },
  fieldLabels: { note: label('Note') },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  // The application's rule: a delete by platform support waits for the business.
  approval: {
    delete: {
      when: (p) => p.onBehalfOf?.kind === 'support',
      by: { capability: 'approvals.decide' },
    },
  },
  traits: { fieldPolicy: { note: 'fixture.issue.note' } },
});

export const Part = z.object({
  id: z.string(),
  title,
  createdAt: z.iso.datetime(),
  ...SharedFields,
});

export const PartSpec = entitySpec({
  name: 'part',
  label: 'part',
  description: 'Parts: a title, shared by the platform with every business.',
  schemas: {
    read: Part,
    create: z.object({ title, ...SharedFromInput }),
    update: z.object({ title: title.optional() }),
  },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  // The platform's rows are published by its operators only.
  traits: { shared: { publishers: 'operators' } },
});

export const RetitlePartSpec = commandSpec({
  name: 'part.retitle',
  description: 'Give a part a new title.',
  input: z.object({ partId: z.uuid(), title }),
  output: Part,
  http: { method: 'POST', path: '/api/parts/:partId/retitle' },
  expose: 'human',
  touches: ['part'],
});

const ISSUE_ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

/** Every business reads parts; operators at platform scope (shared.publish) maintain them. */
const PART_ACCESS: Access = {
  read: {
    owner: 'tenant',
    admin: 'tenant',
    ops: 'tenant',
    staff: 'tenant',
    'shared.publish': 'tenant',
  },
  write: { owner: 'tenant', admin: 'tenant', 'shared.publish': 'tenant' },
};

export const IssueDef = defineEntity(IssueSpec, {
  table: issues,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ISSUE_ACCESS,
  rules: [
    // A request marked #refused: the routed write is refused, and the delivery fails.
    (_p, action, _row, input) =>
      action === 'create' && String(input?.title ?? '').includes('#refused')
        ? deny('fixture_issue_refused', 'Issues marked #refused are refused')
        : null,
  ],
});

export const PartDef = defineSharedEntity(PartSpec, {
  table: parts,
  owner: (t) => t.ownerId,
  access: PART_ACCESS,
});

export const RetitlePart = defineCommand(RetitlePartSpec, {
  resource: { type: 'part', id: (input) => input.partId },
  load: (tx, p, input) => PartDef.repo.get(tx, p, input.partId),
  authorize: () => allow('retitles'),
  summarize: (input) => `Retitle a part: ${input.title}`,
  run: async ({ tx, principal, input, loaded: part, via }) => {
    const after = await PartDef.repo.update(tx, principal, part, { title: input.title }, via);
    return {
      value: PartDef.toRead(after, principal),
      touched: [{ type: 'part', id: part.id, change: 'updated', before: part, after }],
    };
  },
});

@Module({ controllers: [entityController(IssueDef)], providers: [...entityHandlers(IssueDef)] })
class IssuesModule {}

@Module({
  controllers: [entityController(PartDef), commandController(RetitlePart)],
  providers: [...entityHandlers(PartDef), commandHandler(RetitlePart)],
})
class PartsModule {}

export const issuesModule = defineModule({
  ...moduleSpec({ name: 'issues', entities: { issues: IssueSpec }, commands: [] }),
  server: IssuesModule,
  tables: { issues },
});

export const partsModule = defineModule({
  ...moduleSpec({ name: 'parts', entities: { parts: PartSpec }, commands: [RetitlePartSpec] }),
  server: PartsModule,
  tables: { parts },
});

/** The test's codes: `#<code>` in a request's text routes it to that business. */
export const codes = new Map<string, string>();

/**
 * The application's router: a request whose text carries `#<code>` goes to the business with
 * that code, and becomes an issue there for the sender's customer. `#boom` fails after its write.
 */
export const ByCode = defineInboundRouter({
  name: 'fixture-by-code',
  async route(req) {
    const code = /#([a-z0-9-]+)/.exec(req.text ?? '')?.[1];
    const tenantId = code ? codes.get(code) : undefined;
    return tenantId ? { tenantId, reason: `code ${code}` } : null;
  },
  async deliver(req, target) {
    const who = await target.contact();
    const issue = await target.write<{ id: string }>(
      entityOp(IssueDef, 'create', null),
      { title: (req.text ?? 'A request').slice(0, 200) },
      who?.customerId ? { customerId: who.customerId } : {},
    );
    if (req.text?.includes('#boom')) throw new Error('The fixture router failed after its write');
    return { resourceType: 'issue', resourceId: issue.id };
  },
});

/** A flag only the platform switches (its operators): it gates a destination only. */
export const PriorityFlag = defineFeatureFlag({
  key: 'issues.priority',
  label: label('Priority issues'),
  gates: { nav: ['/issues/priority'] },
});

export const platformContributions: Partial<Contributions> = {
  inboundRouters: [ByCode],
  featureFlags: [PriorityFlag],
  capabilities: [
    // A read: support access may hold it when the business consents.
    defineCapability({
      name: 'fixture.issue.note',
      label: label("Read an issue's note"),
      roles: ['owner', 'admin'],
      supportable: true,
    }),
    // Says nothing about support access: support never holds it.
    defineCapability({
      name: 'fixture.issue.close',
      label: label('Close issues'),
      roles: ['owner'],
    }),
  ],
  // Issues may be shared by link (what support access must not leave behind).
  shareables: [defineShareable({ entity: 'issue' })],
};

/** The fixture with issues, parts and the router. */
export const platformServer = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, issuesModule, partsModule],
  contributes: platformContributions,
});
