import {
  CreatedBy,
  CurrencyCode,
  CustomFieldsInput,
  CustomFieldValues,
  entitySpec,
  Money,
  MoneyInput,
} from '@hykr/contracts';
import { z } from 'zod';

const name = z.string().trim().min(1).max(80);
const summary = z.string().trim().min(1).max(2000);

/** Where a brief came from: the team typed it in, or a customer answered the brief form. */
export const BRIEF_SOURCES = ['team', 'form'] as const;
/** The brief form's name: what a share link to it names (server/form.ts declares it). */
export const BRIEF_FORM = 'briefs.brief';
/** A brief is new until someone on the team has read it. */
export const BRIEF_STATUSES = ['new', 'reviewed'] as const;

export const BriefView = z.object({
  id: z.string(),
  name,
  phone: z.string().nullable(),
  summary: z.string(),
  budget: Money.nullable(),
  currency: CurrencyCode,
  neededBy: z.iso.date().nullable(),
  notes: z.string(),
  status: z.enum(BRIEF_STATUSES),
  source: z.enum(BRIEF_SOURCES),
  custom: CustomFieldValues,
  customerId: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type BriefView = z.infer<typeof BriefView>;

export const CreateBriefInput = z.object({
  name,
  phone: z.string().trim().max(20).optional(),
  summary,
  budget: MoneyInput.optional(),
  currency: CurrencyCode.optional(),
  neededBy: z.iso.date().optional(),
  notes: z.string().max(2000).optional(),
  source: z.enum(BRIEF_SOURCES).optional(),
  custom: CustomFieldsInput.optional(),
});
export const UpdateBriefInput = z
  .object({
    name: name.optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    summary: summary.optional(),
    budget: MoneyInput.nullable().optional(),
    neededBy: z.iso.date().nullable().optional(),
    notes: z.string().max(2000).optional(),
    status: z.enum(BRIEF_STATUSES).optional(),
    custom: CustomFieldsInput.optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    'Send at least one field to change',
  );

/**
 * A brief: what a customer needs, in their words, before anything is ordered. The team types one
 * in, or the customer answers the business's brief form (`briefs.brief`, a share link): its
 * questions are these fields and the business's own custom fields.
 */
export const BriefSpec = entitySpec({
  name: 'brief',
  label: 'brief',
  description:
    "Briefs: what a customer needs (a summary, a rough budget, by when), typed in by the team or answered by the customer on the business's brief form.",
  schemas: { read: BriefView, create: CreateBriefInput, update: UpdateBriefInput },
  fieldLabels: {
    name: { en: 'Your name', hi: 'आपका नाम', te: 'మీ పేరు' },
    phone: { en: 'Phone', hi: 'फ़ोन', te: 'ఫోన్' },
    summary: { en: 'What do you need?', hi: 'आपको क्या चाहिए?', te: 'మీకు ఏమి కావాలి?' },
    budget: { en: 'Rough budget', hi: 'अनुमानित बजट', te: 'సుమారు బడ్జెట్' },
    neededBy: { en: 'Needed by', hi: 'कब तक चाहिए', te: 'ఎప్పటికి కావాలి' },
    notes: { en: 'Anything else', hi: 'और कुछ', te: 'ఇంకేమైనా' },
    status: { en: 'Status', hi: 'स्थिति', te: 'స్థితి' },
  },
  list: {
    filterable: {
      status: 'enum',
      source: 'enum',
      name: 'text',
      budget: 'money',
      neededBy: 'date',
      createdAt: 'date',
      custom: 'custom',
    },
    sortable: ['createdAt', 'neededBy'],
    defaultSort: [['createdAt', 'desc']],
    search: ['name', 'summary'],
    pageSize: { default: 25, max: 100 },
    examples: { status: 'new', source: 'form', name: '{ "contains": "asha" }' },
  },
  traits: { money: { fields: ['budget'] }, customFields: {} },
  // An agent never deletes without the person.
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'brief.list' },
});
