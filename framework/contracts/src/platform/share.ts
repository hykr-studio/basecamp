// Share links and public surfaces (docs/decisions/B9.md): what an application lets a business
// show to someone without an account (a record with its children, PDFs and acceptance; a saved
// page; a form that creates a record), and the shapes of `/api/shares` (the team's links) and
// `/api/share/:token` (what a guest sees). The framework declares nothing shareable itself.
import type { Labels } from '@hykr/i18n';
import { z } from 'zod';
import { reserveRoutes } from '../catalog.js';
import { PageSpec } from '../framework/present.js';
import { createHookRegistry } from '../framework/registry.js';
import type { EntitySpec } from '../framework/spec.js';
import { defineCapability } from '../roles.js';
import { BrandColors } from '../settings/branding.js';
import { Lang } from '../voice.js';
import { OtpChannel } from './acceptance.js';

// /api/shares (the team's) and /api/share/:token (a guest's).
reserveRoutes('shares', 'share');

declare module '../framework/module.js' {
  interface Contributions {
    shareables: readonly ShareableDef[];
    publicForms: readonly PublicFormDef[];
  }
}

const same = (en: string, hi: string, te: string): Labels => ({ en, hi, te });

/** The framework's capabilities for share links, overridable like any other. */
export const ShareCapabilities = {
  /** Make a link to a record, a page or a form one reaches, and see the links on it. */
  create: defineCapability({
    name: 'shares.create',
    label: same('Share by link', 'लिंक से साझा करें', 'లింక్ ద్వారా పంచుకోండి'),
    roles: ['owner', 'admin', 'ops', 'staff'],
  }),
  /** Revoke anyone's link in the business. */
  manage: defineCapability({
    name: 'shares.manage',
    label: same('Manage share links', 'साझा लिंक प्रबंधित करें', 'షేర్ లింక్‌లను నిర్వహించండి'),
    roles: ['owner', 'admin'],
  }),
} as const;

/* ── What an application declares ──────────────────────────────────────────── */

/** Whether a link to it needs a one-time code: `required` refuses a link without one. */
export const ShareOtpPolicy = z.enum(['optional', 'required']);
export type ShareOtpPolicy = z.infer<typeof ShareOtpPolicy>;

/**
 * An entity whose records a business may share by link. Nothing is shareable unless a module
 * declares it. A guest reads the record and its declared children (as anyone holding no
 * capability sees them), opens its declared documents, and accepts them when `acceptances`.
 */
export interface ShareableDef {
  /** The entity's name: 'order'. */
  entity: string;
  /** Child entities (`defineChildEntity` of this one) that come with it: 'orderItem'. */
  children?: readonly string[];
  /** Document kinds (`defineDocument` of this entity) a guest may open, once made. */
  documents?: readonly string[];
  /** A guest may accept those documents (their acceptances, B8), as the link's contact. */
  acceptances?: boolean;
  /** Its lists may show on a shared page. Default true. */
  pages?: boolean;
  /** The view a guest sees one record in. Default: the spec's item view. */
  view?: string;
  /** `required`: every link to it needs a one-time code. Default `optional`. */
  otp?: ShareOtpPolicy;
  /** A link to it lasts at most this many days (below the business's `shares.maxDays`). */
  maxDays?: number;
}

/** Every shareable entity, by entity name. Collects `contributes.shareables`. */
export const shareables = createHookRegistry<ShareableDef>('shareable', (s) => s.entity, {
  collects: 'shareables',
});

/** An entity's records may be shared by link: declare it, then contribute it as `shareables`. */
export function defineShareable(def: ShareableDef): ShareableDef {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(def.entity))
    throw new Error(`Shareable "${def.entity}": name the entity ('order')`);
  if (def.maxDays !== undefined && !(Number.isInteger(def.maxDays) && def.maxDays > 0))
    throw new Error(`Shareable "${def.entity}": maxDays is a whole number of days`);
  return def;
}

/** The shareable a child entity comes with: its parent's, when the parent lists it. */
export function shareableOfChild(child: string): ShareableDef | undefined {
  return shareables.all().find((s) => s.children?.includes(child));
}

/**
 * A form anyone with its link may fill in: each answer is one new record of `entity`, created
 * through the entity's own create, owned by the business's default owner and belonging to the
 * link's customer (or a new customer record). What it asks is the application's: fields of the
 * entity's create schema, in its words (`fieldLabels`), and the business's own custom fields.
 */
export interface PublicFormDef {
  /** Dotted, module first: 'briefs.brief'. */
  name: string;
  /** The entity a submission creates: 'brief'. It needs a customer column. */
  entity: string;
  label: Labels;
  description?: Labels;
  /** Keys of the entity's create schema, asked in this order. */
  fields: readonly string[];
  /** Ask the business's custom fields of the entity too (A11). Default: when it has them. */
  custom?: boolean;
  /** Values the server sets on every submission ('source': 'form'), never asked. */
  fixed?: Readonly<Record<string, unknown>>;
  /** The field whose answer names the customer record an anonymous submission creates. */
  customerName?: string;
  /** `required`: every link to it needs a one-time code. Default `optional`. */
  otp?: ShareOtpPolicy;
  /** A link to it lasts at most this many days (below the business's `shares.maxDays`). */
  maxDays?: number;
}

/** Every public form, by name. Collects `contributes.publicForms`. */
export const publicForms = createHookRegistry<PublicFormDef>('public form', (f) => f.name, {
  collects: 'publicForms',
});

/** A form that creates a record: declare it, then contribute it as `publicForms`. */
export function definePublicForm(def: PublicFormDef): PublicFormDef {
  if (!/^[a-z][a-z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/.test(def.name))
    throw new Error(`Public form "${def.name}": name it <module>.<form>, lower case`);
  if (!def.fields.length && def.custom === false)
    throw new Error(`Public form "${def.name}": it asks nothing`);
  if (def.maxDays !== undefined && !(Number.isInteger(def.maxDays) && def.maxDays > 0))
    throw new Error(`Public form "${def.name}": maxDays is a whole number of days`);
  return def;
}

/* ── A form's fields ───────────────────────────────────────────────────────── */

/** What a form field takes. A field of any other type cannot be asked in a public form. */
export const FormFieldType = z.enum([
  'text',
  'longText',
  'number',
  'integer',
  'boolean',
  'date',
  'select',
  'money',
]);
export type FormFieldType = z.infer<typeof FormFieldType>;

const LabelsShape = z.object({ en: z.string(), hi: z.string(), te: z.string() });

/** One question of a public form, as the share page draws it. */
export const FormField = z.object({
  key: z.string(),
  type: FormFieldType,
  label: LabelsShape,
  required: z.boolean(),
  /** A choice's options. */
  options: z.array(z.string()).optional(),
  /** Text: at most this many characters. Numbers: the bounds. */
  max: z.number().optional(),
  min: z.number().optional(),
  /** One of the business's custom fields (sent under `custom`), not the entity's own. */
  custom: z.boolean().optional(),
});
export type FormField = z.infer<typeof FormField>;

/** Longer text than this is asked in a box of several lines. */
const LONG_TEXT = 200;

type Zodish = { _zod: { def: { type: string; innerType?: Zodish } } };

/** The field without its optional, nullable or default wrappers. */
function bare(schema: unknown): Zodish {
  let t = schema as Zodish;
  while (
    ['optional', 'nullable', 'default', 'prefault'].includes(t._zod.def.type) &&
    t._zod.def.innerType
  )
    t = t._zod.def.innerType;
  return t;
}

/** One create-schema field as a question, or why it cannot be one. */
function questionOf(spec: EntitySpec, key: string): FormField | string {
  const field = spec.schemas.create.shape[key];
  if (!field) return `${key} is not a field of ${spec.name}'s create schema`;
  const required = !(field as z.ZodType).safeParse(undefined).success;
  const fallback = { en: key, hi: key, te: key };
  const labels = spec.fieldLabels?.[key];
  const label = labels ? { ...fallback, ...labels } : fallback;
  const base = { key, label, required };
  if (spec.traits?.money?.fields.includes(key)) return { ...base, type: 'money' };
  const json = z.toJSONSchema(bare(field) as unknown as z.ZodType, {
    io: 'input',
    unrepresentable: 'any',
  }) as {
    type?: string;
    format?: string;
    enum?: unknown[];
    maxLength?: number;
    minimum?: number;
    maximum?: number;
  };
  const bounds = {
    ...(json.minimum !== undefined && json.minimum > -Number.MAX_SAFE_INTEGER
      ? { min: json.minimum }
      : {}),
    ...(json.maximum !== undefined && json.maximum < Number.MAX_SAFE_INTEGER
      ? { max: json.maximum }
      : {}),
  };
  if (json.enum?.every((x) => typeof x === 'string'))
    return { ...base, type: 'select', options: json.enum as string[] };
  if (json.type === 'string' && json.format === 'date') return { ...base, type: 'date' };
  if (json.type === 'string' && !json.format)
    return {
      ...base,
      type: (json.maxLength ?? Number.POSITIVE_INFINITY) > LONG_TEXT ? 'longText' : 'text',
      ...(json.maxLength !== undefined ? { max: json.maxLength } : {}),
    };
  if (json.type === 'integer') return { ...base, type: 'integer', ...bounds };
  if (json.type === 'number') return { ...base, type: 'number', ...bounds };
  if (json.type === 'boolean') return { ...base, type: 'boolean' };
  return `${key} is not text, a number, yes or no, a date, a choice or an amount`;
}

/**
 * What is wrong with a form for this entity: a field that is not in its create schema or not of a
 * type a form asks, a required field that is neither asked nor fixed, a `customerName` that is
 * not asked. Empty: it is fine. `defineServer` refuses to start otherwise.
 */
export function publicFormProblems(spec: EntitySpec, def: PublicFormDef): string[] {
  const problems: string[] = [];
  for (const key of def.fields) {
    const q = questionOf(spec, key);
    if (typeof q === 'string') problems.push(q);
  }
  const fixed = Object.keys(def.fixed ?? {});
  for (const [key, field] of Object.entries(spec.schemas.create.shape)) {
    if (key === 'custom') continue;
    const required = !(field as z.ZodType).safeParse(undefined).success;
    if (required && !def.fields.includes(key) && !fixed.includes(key))
      problems.push(`${key} is required by ${spec.name} but neither asked nor fixed`);
  }
  for (const key of fixed)
    if (!(key in spec.schemas.create.shape))
      problems.push(`fixed ${key} is not a field of ${spec.name}'s create schema`);
  if (def.customerName && !def.fields.includes(def.customerName))
    problems.push(`customerName ${def.customerName} is not one of the fields asked`);
  if (def.custom && spec.traits?.customFields === undefined)
    problems.push(`${spec.name} has no custom fields (the customFields trait)`);
  return problems;
}

/** The questions the application's part of a form asks, in order. */
export function formFieldsOf(spec: EntitySpec, def: PublicFormDef): FormField[] {
  return def.fields.map((key) => {
    const q = questionOf(spec, key);
    if (typeof q === 'string') throw new Error(`Public form "${def.name}": ${q}`);
    return q;
  });
}

/** Does the form also ask the business's own fields? */
export const formAsksCustom = (spec: EntitySpec, def: PublicFormDef) =>
  def.custom ?? spec.traits?.customFields !== undefined;

/* ── /api/shares: the team's links ─────────────────────────────────────────── */

/** What a link opens: a record, a saved page, or a form. */
export const ShareTarget = z.union([
  z.object({ entity: z.string().min(1).max(64), id: z.string().uuid() }).strict(),
  z.object({ page: z.string().uuid() }).strict(),
  z.object({ form: z.string().min(1).max(120) }).strict(),
]);
export type ShareTarget = z.infer<typeof ShareTarget>;

/** Whom a link is for: where its code goes, and who signs through it. */
export const ShareRecipient = z.union([
  z.object({ contactId: z.string().uuid() }).strict(),
  z.object({ customerId: z.string().uuid() }).strict(),
  z.object({ email: z.email().max(320) }).strict(),
  /** The shared record's own customer (its `customerId`), when it has one; else nobody. */
  z.object({ recordCustomer: z.literal(true) }).strict(),
]);
export type ShareRecipient = z.infer<typeof ShareRecipient>;

export const CreateShareInput = z.object({
  target: ShareTarget,
  /** Days until it ends. Default: the business's `shares.defaultDays`. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  /** Ask the recipient for a one-time code before anything is shown. */
  otp: OtpChannel.nullable().optional(),
  to: ShareRecipient.optional(),
  /** A form link: at most this many answers. */
  maxUses: z.number().int().min(1).max(100_000).optional(),
  label: z.string().trim().min(1).max(120).optional(),
});
export type CreateShareInput = z.input<typeof CreateShareInput>;

export const ShareStatus = z.enum(['active', 'expired', 'revoked', 'used']);
export type ShareStatus = z.infer<typeof ShareStatus>;

/** A link as the team sees it: never its token. */
export const ShareLinkInfo = z.object({
  id: z.string(),
  kind: z.enum(['record', 'page', 'form']),
  target: ShareTarget,
  label: z.string().nullable(),
  status: ShareStatus,
  /** Where its code goes, masked, and how; null when it asks for none. */
  otp: z.object({ channel: OtpChannel, sentTo: z.string() }).nullable(),
  /** Its recipient, as the business knows them (ids), when it has one. */
  to: z
    .object({
      contactId: z.string().nullable(),
      customerId: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
  uses: z.number().int(),
  maxUses: z.number().int().nullable(),
  views: z.number().int(),
  lastViewedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});
export type ShareLinkInfo = z.infer<typeof ShareLinkInfo>;

/** A link just made: its token, shown once, and where it opens. */
export const ShareCreated = ShareLinkInfo.extend({
  token: z.string(),
  /** '/share/<token>', under the app's address. */
  path: z.string(),
  url: z.string(),
});
export type ShareCreated = z.infer<typeof ShareCreated>;

/** One shareable entity, as `GET /api/shares/kinds` lists it. */
export const ShareableInfo = z.object({
  entity: z.string(),
  children: z.array(z.string()),
  documents: z.array(z.string()),
  acceptances: z.boolean(),
  pages: z.boolean(),
  otp: ShareOtpPolicy,
});
export type ShareableInfo = z.infer<typeof ShareableInfo>;

/** One public form, as `GET /api/shares/kinds` lists it. */
export const PublicFormInfo = z.object({
  name: z.string(),
  entity: z.string(),
  label: LabelsShape,
  otp: ShareOtpPolicy,
});
export type PublicFormInfo = z.infer<typeof PublicFormInfo>;

export type ShareKinds = { entities: ShareableInfo[]; forms: PublicFormInfo[] };

/* ── /api/share/:token: what a guest sees ──────────────────────────────────── */

/** A shared record: its view, the record as a guest sees it, its children and its PDFs. */
export const SharedRecord = z.object({
  entity: z.string(),
  id: z.string(),
  /** The registered view it is shown in, or null (the share page lists its fields). */
  view: z.string().nullable(),
  value: z.record(z.string(), z.unknown()),
  /** Each declared child entity's rows, as a guest sees them, a parent before its children. */
  children: z.array(
    z.object({
      entity: z.string(),
      items: z.array(z.record(z.string(), z.unknown())),
      truncated: z.boolean(),
    }),
  ),
  /** Its declared documents that are made, newest first. */
  documents: z.array(
    z.object({
      id: z.string(),
      document: z.string(),
      name: z.string(),
      version: z.number().int(),
      /** It has an acceptance a guest may go through here. */
      acceptable: z.boolean(),
    }),
  ),
});
export type SharedRecord = z.infer<typeof SharedRecord>;

/** One block of a shared page, with its data (by the view's source). */
export const SharedBlock = z.object({
  id: z.string(),
  view: z.string(),
  query: z.record(z.string(), z.unknown()).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  span: z.enum(['full', 'half']).optional(),
  /** `items` for a list, `record` for one by id, `summary` for counts and totals. */
  data: z.object({
    items: z.array(z.unknown()).optional(),
    record: z.unknown().optional(),
    summary: z.unknown().optional(),
  }),
});
export type SharedBlock = z.infer<typeof SharedBlock>;

export const SharedPage = z.object({
  id: z.string(),
  name: z.string(),
  layout: PageSpec.shape.layout,
  blocks: z.array(SharedBlock),
});
export type SharedPage = z.infer<typeof SharedPage>;

export const SharedForm = z.object({
  name: z.string(),
  entity: z.string(),
  label: LabelsShape,
  description: LabelsShape.nullable(),
  fields: z.array(FormField),
  /** The business's currency, for amounts. */
  currency: z.string(),
  /** Answers it still takes (null: no limit). */
  remaining: z.number().int().nullable(),
});
export type SharedForm = z.infer<typeof SharedForm>;

/** `GET /api/share/:token`. A gated link shows only `link`, `business` and `gate` until its code. */
export const Shared = z.object({
  link: z.object({
    id: z.string(),
    kind: z.enum(['record', 'page', 'form']),
    label: z.string().nullable(),
    expiresAt: z.iso.datetime(),
  }),
  business: z.object({
    name: z.string(),
    logoUrl: z.string().nullable(),
    colors: BrandColors.partial().nullable(),
  }),
  gate: z.object({ channel: OtpChannel, sentTo: z.string(), verified: z.boolean() }).nullable(),
  record: SharedRecord.optional(),
  page: SharedPage.optional(),
  form: SharedForm.optional(),
});
export type Shared = z.infer<typeof Shared>;

export const ShareCodeInput = z.object({ lang: Lang.optional() }).strict();
export const ShareVerifyInput = z
  .object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) })
  .strict();
export type ShareVerifyInput = z.infer<typeof ShareVerifyInput>;

/** A code sent for a gated link. */
export type ShareCodeSent = {
  id: string;
  channel: 'whatsapp' | 'email';
  sentTo: string;
  expiresAt: string;
};
/** The session a right code opened: send it as `x-share-session`. */
export type ShareSession = { session: string; expiresAt: string };

/** A form's answers: its own fields under `values`, the business's under `custom`. */
export const ShareSubmitInput = z
  .object({
    values: z.record(z.string(), z.unknown()),
    custom: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .strict();
export type ShareSubmitInput = z.infer<typeof ShareSubmitInput>;

/** What a submission answers: the new record, by id. */
export type ShareSubmitted = { entity: string; id: string };

/** The header a gated link's session travels in. */
export const SHARE_SESSION_HEADER = 'x-share-session';
/** Where a link opens in the app. */
export const sharePath = (token: string) => `/share/${token}`;
