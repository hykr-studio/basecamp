// Offline capture (B12), on neutral data: a `jots` module whose jots may be written offline (the
// `offline` trait: a person's app chooses a new jot's id), carry a version (If-Match), a secret
// only reviewers read, and a create that waits for a reviewer when it asks for review. Only the
// offline test boots this server (`offlineServer`).
import { defineModule, defineServer } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  defineCapability,
  entitySpec,
  moduleSpec,
} from '@hykr/contracts';
import { defineEntity, entityController, entityHandlers } from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { jots } from './schema.js';

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);

export const Jot = z.object({
  id: z.string(),
  title,
  // Optional: removed for whoever may not read it.
  secret: z.string().nullable().optional(),
  review: z.boolean(),
  version: z.number().int(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const JotSpec = entitySpec({
  name: 'jot',
  label: 'jot',
  description: 'Jots: a title, made on a phone that may be offline.',
  schemas: {
    read: Jot,
    create: z.object({
      title,
      secret: z.string().max(200).optional(),
      review: z.boolean().optional(),
    }),
    update: z.object({
      title: title.optional(),
      secret: z.string().max(200).nullable().optional(),
    }),
  },
  fieldLabels: { secret: label('Secret') },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  // A jot asked for review waits for someone who reviews jots (never its maker).
  approval: {
    create: {
      when: (_p, { input }) => input?.review === true,
      by: { capability: 'fixture.jots.review' },
    },
  },
  traits: {
    offline: {},
    versioned: {},
    fieldPolicy: { secret: 'fixture.jots.secret' },
  },
});

export const jotsSpec = moduleSpec({ name: 'jots', entities: { jots: JotSpec }, commands: [] });

const ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const JotDef = defineEntity(JotSpec, {
  table: jots,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

@Module({ controllers: [entityController(JotDef)], providers: [...entityHandlers(JotDef)] })
class JotsModule {}

export const jotsModule = defineModule({ ...jotsSpec, server: JotsModule, tables: { jots } });

export const offlineContributions: Partial<Contributions> = {
  capabilities: [
    defineCapability({
      name: 'fixture.jots.secret',
      label: label("Read jots' secrets"),
      roles: ['owner', 'admin'],
    }),
    defineCapability({
      name: 'fixture.jots.review',
      label: label('Review jots'),
      roles: ['owner', 'admin'],
    }),
  ],
};

/** The fixture with the jots module. */
export const offlineServer = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, jotsModule],
  contributes: offlineContributions,
});
