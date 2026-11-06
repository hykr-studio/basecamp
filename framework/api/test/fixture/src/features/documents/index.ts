// The documents feature in use (B2): a `memos` module with a field only owners see (a read
// projector by capability), a role that reads memos and nothing else, three documents of a memo
// (one that counts every role and capability of its requester, one that names the capability
// that matters, one that hides nothing), a WhatsApp template with a document header, scripts for
// the assistant, and the server the documents e2e test boots (`documentsApp`).
import { call, defineScript, items, say, written } from '@hykr/agents/script';
import { defineDocument, defineModule, defineServer } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  defineCapability,
  defineRole,
  entitySpec,
  moduleSpec,
} from '@hykr/contracts';
import { defineEntity, entityController, entityHandlers, type ReadProjector } from '@hykr/core';
import { defineTemplate } from '@hykr/notifications';
import { type Access, can } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { memos } from './schema.js';

const same = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);

export const Memo = z.object({
  id: z.string(),
  title,
  body: z.string(),
  /** Only with memos.secret.read. */
  secret: z.string().nullable().optional(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const MemoSpec = entitySpec({
  name: 'memo',
  label: 'memo',
  description: 'Memos: a title, a body, and a line only owners see.',
  schemas: {
    read: Memo,
    create: z.object({
      title,
      body: z.string().max(5000).default(''),
      secret: z.string().optional(),
    }),
    update: z.object({ title: title.optional(), body: z.string().max(5000).optional() }),
  },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
  },
});

/** A role that reads memos and does nothing else (it cannot message anyone). */
export const Reader = defineRole({ name: 'fixture_reader', label: same('Reader') });

/** Who sees a memo's secret line. */
export const SecretRead = defineCapability({
  name: 'memos.secret.read',
  label: same('Read secret lines'),
  roles: ['owner'],
});

/** Everyone in the business reads every memo; staff write their own; readers only read. */
const ACCESS: Access = {
  read: {
    owner: 'tenant',
    admin: 'tenant',
    ops: 'tenant',
    staff: 'tenant',
    fixture_reader: 'tenant',
    customer: 'customer',
  },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const MemoDef = defineEntity(MemoSpec, {
  table: memos,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

/** The secret line leaves only for whoever may read it. */
export const secretHidden: ReadProjector = {
  name: 'fixture.memos.secret',
  project: (type, value, p) => {
    if (type !== 'memo' || can(p, SecretRead)) return value;
    const { secret: _hidden, ...rest } = value;
    return rest;
  },
};

@Module({ controllers: [entityController(MemoDef)], providers: [...entityHandlers(MemoDef)] })
export class MemosModule {}

/** Sent with a memo's PDF on WhatsApp. */
export const MemoDocumentTemplate = defineTemplate({
  name: 'memo_document_v1',
  category: 'utility',
  params: z.object({ title: z.string().max(60) }),
  body: same('Here is the memo {{title}}.'),
  header: { type: 'document' },
  example: { title: 'Plan' },
});

type MemoData = { title: string; body: string; secret: string | null; at: string };

const memoData = ({ record }: { record: Record<string, unknown> }): MemoData => ({
  title: String(record.title),
  body: String(record.body ?? ''),
  secret: (record.secret as string | undefined) ?? null,
  at: String(record.createdAt),
});

/** A memo: everything its requester saw (no `capabilities`: every role and capability counts). */
export const MemoDocument = defineDocument<MemoData>({
  name: 'memos.memo',
  label: same('Memo'),
  entity: 'memo',
  load: memoData,
  render: (d, ctx) => ({
    title: `Memo ${d.title}`,
    header: { left: ctx.business.name, right: d.title },
    footer: { right: 'Page {page} of {pages}' },
    blocks: [
      { type: 'heading', text: d.title.toUpperCase() },
      { type: 'fields', items: [{ label: 'Written', value: ctx.date(d.at) }] },
      { type: 'text', text: d.body },
      ...(d.secret ? [{ type: 'text' as const, text: `Secret: ${d.secret}`, bold: true }] : []),
    ],
  }),
  fileName: (d) => `memo-${d.title}`,
  send: {
    whatsapp: { template: MemoDocumentTemplate, params: (d) => ({ title: d.title.slice(0, 60) }) },
    email: {
      subject: (d) => `Memo ${d.title}`,
      body: (d) => `The memo ${d.title} is attached.`,
    },
  },
});

/** The same, naming the one capability that changes what it shows. */
export const MemoSheet = defineDocument<MemoData>({
  name: 'memos.sheet',
  label: same('Memo sheet'),
  entity: 'memo',
  capabilities: [SecretRead.name],
  load: memoData,
  render: (d) => ({
    title: `Sheet ${d.title}`,
    blocks: [
      { type: 'heading', text: d.title },
      ...(d.secret ? [{ type: 'text' as const, text: `Secret: ${d.secret}` }] : []),
    ],
  }),
  fileName: (d) => `sheet-${d.title}.pdf`,
});

/** Only the title: nothing anyone who reads the memo may not see. Email only. */
export const MemoCard = defineDocument<{ title: string }>({
  name: 'memos.card',
  label: same('Memo card'),
  entity: 'memo',
  capabilities: [],
  load: ({ record }) => ({ title: String(record.title) }),
  render: (d) => ({
    title: d.title,
    page: { size: 'A5', margin: 36 },
    blocks: [
      { type: 'heading', text: d.title, level: 2 },
      {
        type: 'table',
        columns: [{ label: 'What' }, { label: 'How many', align: 'right', width: 0.5 }],
        rows: [
          { cells: ['Group', ''], kind: 'group' },
          { cells: ['One line', '1'], indent: 1 },
          { cells: ['Sum', '1'], kind: 'subtotal' },
        ],
      },
      { type: 'totals', rows: [{ label: 'Total', value: '1', strong: true }] },
    ],
  }),
  fileName: (d) => `card-${d.title}`,
  send: { email: { subject: (d) => `Card ${d.title}`, body: () => 'The card is attached.' } },
});

/**
 * The assistant's scripts:
 *   pdf of memo <title>         list-memos → render-document (memos.memo)
 *   send memo <title> to me     list-memos → render-document → send-document to yourself
 */
export const memoScripts = [
  defineScript({
    name: 'memo-pdf',
    match: (text) => /^pdf of memo (.+)$/i.exec(text.trim())?.[1],
    step: (named, turn) => {
      const found = turn.result('list-memos');
      if (!found) return [call('list-memos', { q: named })];
      const [memo] = items(found) as unknown as { id: string }[];
      if (!memo) return [say(`There is no memo ${named}.`)];
      const made = turn.result('render-document');
      if (!made) return [call('render-document', { document: 'memos.memo', id: memo.id })];
      return [
        say(
          written(
            made,
            (v) => {
              const d = v as unknown as { id: string; name: string };
              return `Making ${d.name}: document ${d.id}.`;
            },
            turn,
          ),
        ),
      ];
    },
  }),
  defineScript({
    name: 'memo-send-to-me',
    match: (text) => /^send memo (.+) to me$/i.exec(text.trim())?.[1],
    step: (named, turn) => {
      const found = turn.result('list-memos');
      if (!found) return [call('list-memos', { q: named })];
      const [memo] = items(found) as unknown as { id: string }[];
      if (!memo) return [say(`There is no memo ${named}.`)];
      const made = turn.result('render-document');
      if (!made) return [call('render-document', { document: 'memos.memo', id: memo.id })];
      const sent = turn.result('send-document');
      const doc = (made.result as { value?: { id: string } }).value;
      if (!sent && doc) return [call('send-document', { documentId: doc.id, to: { self: true } })];
      return [say(written(sent ?? made, () => `Sending memo ${named} to you.`, turn))];
    },
  }),
];

export const memosModule = defineModule({
  ...moduleSpec({ name: 'memos', dependsOn: [], entities: { memos: MemoSpec }, commands: [] }),
  server: MemosModule,
  templates: [MemoDocumentTemplate],
  agent: { scripts: memoScripts },
  tables: { memos },
});

export const documentsContributions: Partial<Contributions> = {
  roles: [Reader],
  capabilities: [SecretRead],
  readProjectors: [secretHidden],
  documents: [MemoDocument, MemoSheet, MemoCard],
};

/** The fixture plus memos and their documents. */
export const documentsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, memosModule],
  contributes: documentsContributions,
});
