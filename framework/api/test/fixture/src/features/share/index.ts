// The share feature in use (B9), on neutral data: inquiries (a public form creates one; a field
// only some roles read; the business's custom fields; a topic that would wait for an approval),
// shared baskets with their items (an item's cost only some roles read), and shared agreements
// with their PDF and its acceptance (B8). The server the share e2e test boots (`shareApp`).
import { defineModule, defineServer } from '@hykr/api';
import {
  CreatedBy,
  CustomFieldsInput,
  CustomFieldValues,
  defineCapability,
  definePublicForm,
  defineShareable,
  entitySpec,
  moduleSpec,
} from '@hykr/contracts';
import { defineEntity, entityController, entityHandlers, type ReadProjector } from '@hykr/core';
import { pick } from '@hykr/i18n';
import { type Access, can } from '@hykr/policy';
import { defineView, spokenList, type ViewDef, type ViewLabels } from '@hykr/ui-registry';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { acceptanceContributions, agreementsModule } from '../acceptance/index.js';
import { basketsModule } from '../line-items/index.js';
import { inquiries } from './schema.js';

const same = (en: string) => ({ en, hi: en, te: en });
const TOPICS = ['general', 'pricing', 'review'] as const;

/** Who reads an inquiry's score. */
export const ScoreRead = defineCapability({
  name: 'fixture.inquiries.score',
  label: same('See scores'),
  roles: ['owner'],
});

/** Who reads a basket item's cost (anyone else, a guest above all, never). */
export const CostRead = defineCapability({
  name: 'fixture.share.cost',
  label: same('See basket costs'),
  roles: ['owner'],
});

export const Inquiry = z.object({
  id: z.string(),
  name: z.string(),
  topic: z.enum(TOPICS),
  guests: z.number().int().nullable(),
  wanted: z.iso.date().nullable(),
  notes: z.string(),
  urgent: z.boolean(),
  /** Only with fixture.inquiries.score. */
  score: z.number().int().nullable().optional(),
  source: z.string(),
  custom: CustomFieldValues,
  customerId: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const InquirySpec = entitySpec({
  name: 'inquiry',
  plural: 'inquiries',
  label: 'inquiry',
  description: 'Inquiries: what someone asked, from the team or through a public form.',
  schemas: {
    read: Inquiry,
    create: z.object({
      name: z.string().trim().min(1).max(80),
      topic: z.enum(TOPICS).default('general'),
      guests: z.number().int().min(1).max(50).optional(),
      wanted: z.iso.date().optional(),
      notes: z.string().max(1000).optional(),
      urgent: z.boolean().optional(),
      score: z.number().int().optional(),
      source: z.string().max(40).optional(),
      custom: CustomFieldsInput.optional(),
    }),
    update: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      notes: z.string().max(1000).optional(),
      score: z.number().int().nullable().optional(),
      custom: CustomFieldsInput.optional(),
    }),
  },
  fieldLabels: {
    name: same('Your name'),
    topic: same('Topic'),
    guests: same('Guests'),
    wanted: same('Wanted by'),
    notes: same('Anything else'),
    urgent: same('Urgent'),
  },
  list: {
    filterable: { topic: 'enum', name: 'text', score: 'number', custom: 'custom' },
    sortable: ['createdAt', 'score'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  traits: { customFields: {}, fieldPolicy: { score: ScoreRead.name } },
  // A review inquiry waits for someone's approval: a guest's never can (decisions B9, 18).
  approval: { create: (_p, { input }) => (input as { topic?: string } | null)?.topic === 'review' },
  views: { list: 'inquiry.list' },
});

const ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const InquiryDef = defineEntity(InquirySpec, {
  table: inquiries,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
  summarize: (action, input, row) =>
    `${action === 'create' ? 'Add' : 'Change'} inquiry ${String(input?.name ?? row?.name ?? '')}`,
});

@Module({
  controllers: [entityController(InquiryDef)],
  providers: [...entityHandlers(InquiryDef)],
})
export class InquiriesModule {}

const labels = {
  title: same('Inquiries'),
  empty: same('No inquiries.'),
  noun: {
    en: ['inquiry', 'inquiries'],
    hi: ['inquiry', 'inquiries'],
    te: ['inquiry', 'inquiries'],
  },
} satisfies ViewLabels;

export const InquiryListView = defineView({
  name: 'inquiry.list',
  description: 'A list of inquiries.',
  surfaces: ['inline', 'canvas', 'text'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(Inquiry) }),
  source: { entity: InquirySpec, into: 'items' },
  labels,
  text: (p, ctx) =>
    p.items.length ? p.items.map((i) => `• ${i.name}`).join('\n') : pick(labels.empty, ctx.lang),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((i) => i.name),
      labels,
      ctx,
    ),
});

export const inquiriesModule = defineModule({
  ...moduleSpec({ name: 'inquiries', entities: { inquiries: InquirySpec }, commands: [] }),
  server: InquiriesModule,
  views: [InquiryListView] as unknown as readonly ViewDef[],
  tables: { inquiries },
});

/** A basket item's cost leaves only for whoever may see it. */
export const guestCostHidden: ReadProjector = {
  name: 'fixture.share.cost',
  project: (type, value, p) => {
    if (type !== 'basketItem' || can(p, CostRead)) return value;
    const { cost: _hidden, ...rest } = value;
    return rest;
  },
};

export const InquiryForm = definePublicForm({
  name: 'inquiries.inquiry',
  entity: 'inquiry',
  label: same('Ask us'),
  description: same('Tell us what you need.'),
  fields: ['name', 'topic', 'guests', 'wanted', 'notes', 'urgent'],
  customerName: 'name',
  fixed: { source: 'form' },
});

/** A form that must be gated, and lasts at most 3 days. */
export const GatedForm = definePublicForm({
  name: 'inquiries.private',
  entity: 'inquiry',
  label: same('Ask us privately'),
  fields: ['name', 'notes'],
  custom: false,
  otp: 'required',
  maxDays: 3,
});

export const shareContributions = {
  ...acceptanceContributions,
  capabilities: [...(acceptanceContributions.capabilities ?? []), ScoreRead, CostRead],
  readProjectors: [...(acceptanceContributions.readProjectors ?? []), guestCostHidden],
  shareables: [
    defineShareable({ entity: 'inquiry' }),
    defineShareable({ entity: 'basket', children: ['basketItem'], pages: false }),
    defineShareable({
      entity: 'agreement',
      documents: ['agreements.agreement'],
      acceptances: true,
      maxDays: 30,
    }),
  ],
  publicForms: [InquiryForm, GatedForm],
};

/** The fixture plus agreements, baskets and inquiries, and what may be shared of them. */
export const shareApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, agreementsModule, basketsModule, inquiriesModule],
  contributes: shareContributions,
});
