// The files feature in use (B1): a `cards` module whose entity has every kind of file field (one
// cover image, up to three photos, attachments, and a field staff never see), scripts that put a
// file sent on WhatsApp on a new card, and the server the files e2e test boots (`filesApp`).
import { call, defineScript, say, written } from '@hykr/agents/script';
import { defineModule, defineServer } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  entitySpec,
  FileRef,
  fileRefs,
  moduleSpec,
} from '@hykr/contracts';
import { defineEntity, type EntityPlugin, entityController, entityHandlers } from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { cards } from './schema.js';

const title = z.string().min(1).max(200);

export const Card = z.object({
  id: z.string(),
  title,
  cover: FileRef.nullable(),
  photos: fileRefs(3),
  attachments: fileRefs(),
  secret: FileRef.nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const CardSpec = entitySpec({
  name: 'card',
  label: 'card',
  description: 'Cards: a title, a cover image, photos, attachments and a private file.',
  schemas: {
    read: Card,
    create: z.object({
      title,
      cover: FileRef.optional(),
      photos: fileRefs(3).optional(),
      attachments: fileRefs().optional(),
      secret: FileRef.optional(),
    }),
    update: z.object({
      title: title.optional(),
      cover: FileRef.nullable().optional(),
      photos: fileRefs(3).optional(),
      attachments: fileRefs().optional(),
      secret: FileRef.nullable().optional(),
    }),
  },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  // The assistant's changes to a card wait for the person.
  approval: { update: (p) => p.actor.kind === 'agent' },
  traits: {
    files: {
      cover: { accept: ['image/*'], maxBytes: 200_000 },
      photos: { accept: ['image/*'], max: 3 },
      attachments: { accept: ['application/pdf', 'audio/*', 'text/plain'] },
      secret: {},
    },
  },
});

/** Everyone in the business reads every card; staff write only their own. */
const ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'tenant', customer: 'customer' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const CardDef = defineEntity(CardSpec, {
  table: cards,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

/** Staff never see a card's `secret`: nor, then, its file. */
export const hideSecret: EntityPlugin = {
  name: 'fixture.files.secret',
  appliesTo: (spec) => spec.name === 'card',
  project: (read, p) => {
    if (!p.roles?.includes('staff')) return read;
    const { secret: _hidden, ...rest } = read;
    return rest;
  },
};

@Module({ controllers: [entityController(CardDef)], providers: [...entityHandlers(CardDef)] })
export class CardsModule {}

const FILE_ID = /file id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** "card for <title>" with a file sent on WhatsApp: a new card with that photo. */
export const cardScripts = [
  defineScript({
    name: 'card-with-photo',
    match: (text) => {
      const named = /^card for (.+)$/im.exec(text)?.[1]?.trim();
      const file = FILE_ID.exec(text)?.[1];
      return named && file ? { named, file } : undefined;
    },
    step: ({ named, file }, turn) => {
      const r = turn.result('create-card');
      if (!r) return [call('create-card', { title: named, photos: [file] })];
      return [say(written(r, () => `Kept it on the card "${named}".`, turn))];
    },
  }),
];

export const cardsModule = defineModule({
  ...moduleSpec({ name: 'cards', dependsOn: [], entities: { cards: CardSpec }, commands: [] }),
  server: CardsModule,
  agent: { scripts: cardScripts },
  tables: { cards },
});

export const filesContributions: Partial<Contributions> = { entityPlugins: [hideSecret] };

/** The fixture plus cards. */
export const filesApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, cardsModule],
  contributes: filesContributions,
});
