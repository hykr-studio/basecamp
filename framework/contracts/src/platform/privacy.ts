// Requests about personal data (B18): a person asks for a copy of what a business holds about
// them, or to be forgotten; the business answers within its deadline. Served by @hykr/api's
// `privacy` feature (`/api/privacy`); every step goes through the write path and is audited.
// docs/decisions/B18.md.
import { z } from 'zod';
import { RETENTION_NAME } from '../framework/privacy.js';
import { commandSpec } from '../framework/spec.js';
import { capabilities, defineCapability } from '../roles.js';
import { PrivacyRequestKind, ProcessorRecord } from '../settings/privacy.js';

/** Answer the business's privacy requests: see them, file one for someone, process or refuse. */
export const PrivacyManageCapability = defineCapability({
  name: 'privacy.manage',
  label: {
    en: 'Handle requests about personal data',
    hi: 'निजी डेटा के अनुरोध संभालें',
    te: 'వ్యక్తిగత డేటా అభ్యర్థనలను నిర్వహించండి',
  },
  roles: ['owner', 'admin'],
});
capabilities.register(PrivacyManageCapability);

/** What `privacyRequest` records are called in audit, events, live updates and files. */
export const PRIVACY_REQUEST = 'privacyRequest';

/**
 * received: waiting for someone with `privacy.manage`; in_progress: being carried out; then
 * completed, refused (with a reason) or failed (with a reason; it can be processed again).
 */
export const PrivacyRequestStatus = z.enum([
  'received',
  'in_progress',
  'completed',
  'refused',
  'failed',
]);
export type PrivacyRequestStatus = z.infer<typeof PrivacyRequestStatus>;

/** The statuses a request is still open in. */
export const OPEN_PRIVACY_STATUSES: readonly PrivacyRequestStatus[] = ['received', 'in_progress'];

/** How the request reached the business. */
export const PrivacyIntake = z.enum([
  'app',
  'whatsapp',
  'email',
  'phone',
  'post',
  'in_person',
  'other',
]);
export type PrivacyIntake = z.infer<typeof PrivacyIntake>;

/** Whom a request is about: a person with an account, or a WhatsApp contact. */
export const PrivacySubject = z.object({
  kind: z.enum(['user', 'contact']),
  id: z.string(),
});
export type PrivacySubject = z.infer<typeof PrivacySubject>;

/** One request, as its person and the business's privacy team read it. */
export const PrivacyRequest = z.object({
  id: z.string(),
  kind: PrivacyRequestKind,
  status: PrivacyRequestStatus,
  subject: PrivacySubject,
  intake: PrivacyIntake,
  /** Who filed it, as audit names them. */
  requestedBy: z.object({ kind: z.string(), id: z.string() }),
  /** What the team noted when they filed it. */
  note: z.string().nullable(),
  /** Why it was refused or failed. */
  reason: z.string().nullable(),
  /** What was done, by part: rows exported or erased, records kept and why. */
  outcome: z.record(z.string(), z.unknown()).nullable(),
  /** A completed export's archive (ids for `/api/files`). */
  files: z.array(z.string()),
  receivedAt: z.iso.datetime(),
  /** It must be answered by then (null: the business set no deadline). */
  dueAt: z.iso.datetime().nullable(),
  /** When it was found past its deadline, still open. */
  overdueAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type PrivacyRequest = z.infer<typeof PrivacyRequest>;

/** Someone the business knows: by account (id or email) or by contact (id or WhatsApp number). */
export const PrivacyFor = z.union([
  z.object({ userId: z.string().min(1).max(64) }).strict(),
  z.object({ email: z.email().max(320) }).strict(),
  z.object({ contactId: z.string().min(1).max(64) }).strict(),
  z
    .object({ address: z.string().regex(/^\+?\d{6,20}$/, 'A WhatsApp number, digits only') })
    .strict(),
]);
export type PrivacyFor = z.infer<typeof PrivacyFor>;

export const FilePrivacyRequestInput = z.object({
  kind: PrivacyRequestKind,
  /** Whom it is about. Default: whoever files it. Someone else needs `privacy.manage`. */
  for: PrivacyFor.optional(),
  /** How it reached the business. Default: the app (yourself), else other. */
  intake: PrivacyIntake.optional(),
  note: z.string().trim().max(1000).optional(),
});
export type FilePrivacyRequestInput = z.input<typeof FilePrivacyRequestInput>;

export const FilePrivacyRequestSpec = commandSpec({
  name: 'privacy.request',
  description:
    'Ask for a copy of the personal data the business holds about a person, or for it to be erased.',
  input: FilePrivacyRequestInput,
  output: PrivacyRequest,
  http: { method: 'POST', path: '/api/privacy/requests' },
  expose: 'human',
  verb: { do: 'file a privacy request', did: 'filed a privacy request' },
  touches: [],
});

export const ProcessPrivacyRequestSpec = commandSpec({
  name: 'privacy.process',
  description: 'Carry out a privacy request that waits for review, or one that failed.',
  input: z.object({ requestId: z.uuid() }),
  output: PrivacyRequest,
  http: { method: 'POST', path: '/api/privacy/requests/:requestId/process' },
  expose: 'human',
  verb: { do: 'process a privacy request', did: 'processed a privacy request' },
  touches: [],
});

export const RefusePrivacyRequestSpec = commandSpec({
  name: 'privacy.refuse',
  description: 'Refuse a privacy request, saying why.',
  input: z.object({ requestId: z.uuid(), reason: z.string().trim().min(1).max(1000) }),
  output: PrivacyRequest,
  http: { method: 'POST', path: '/api/privacy/requests/:requestId/refuse' },
  expose: 'human',
  verb: { do: 'refuse a privacy request', did: 'refused a privacy request' },
  touches: [],
});

/**
 * A business's privacy setup as its privacy team edits it (GET and PATCH /api/privacy/settings):
 * its `privacy` settings and its contact details as the fiduciary. Values as they apply now:
 * an unset deadline or contact shows the application's, or the framework's default.
 */
export const PrivacyConfiguration = z.object({
  /** Its own deadline in days; null: the application's policy (`register.requests` says which). */
  respondWithinDays: z.number().int().nullable(),
  /** A person's own requests of these kinds wait for review here, besides the application's. */
  review: z.array(PrivacyRequestKind),
  /** Its own periods by rule or target name: days, or null (that data is kept). */
  retention: z.record(z.string(), z.number().int().nullable()),
  /** Its own processors, listed on its register after the application's. */
  processors: z.array(ProcessorRecord),
  /** Who to contact about personal data: on the register and in WhatsApp's HELP. */
  grievanceContact: z.string(),
  /** Its privacy notice: in WhatsApp's welcome and on the register. */
  privacyUrl: z.string().nullable(),
});
export type PrivacyConfiguration = z.infer<typeof PrivacyConfiguration>;

/**
 * What `privacy.configure` changes. A field left out stays as it is; a list given replaces the
 * stored one; null goes back to the default.
 */
export const ConfigurePrivacyInput = z.object({
  /** null: the application's deadline. */
  respondWithinDays: z.int().min(1).max(365).nullable().optional(),
  review: z.array(PrivacyRequestKind).max(2).optional(),
  /**
   * Every period the business sets itself, by the name of a retention rule or target the
   * business may change (one per business, not the deployment's): whole days, or null to keep
   * that data. A name left out follows the application's period.
   */
  retention: z
    .record(
      z.string().regex(RETENTION_NAME, 'A retention rule or target name'),
      z.int().min(1).max(36_500).nullable(),
    )
    .optional(),
  processors: z.array(ProcessorRecord).max(50).optional(),
  /** An email, phone number or address; null: the default. */
  grievanceContact: z.string().trim().min(3).max(320).nullable().optional(),
  privacyUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .nullable()
    .optional(),
});
export type ConfigurePrivacyInput = z.input<typeof ConfigurePrivacyInput>;

export const ConfigurePrivacySpec = commandSpec({
  name: 'privacy.configure',
  description:
    'Change how the business answers privacy requests, how long it keeps personal data, its own processors and its privacy contact.',
  input: ConfigurePrivacyInput,
  output: PrivacyConfiguration,
  http: { method: 'PATCH', path: '/api/privacy/settings' },
  expose: 'human',
  verb: { do: 'change the privacy settings', did: 'changed the privacy settings' },
  touches: [],
});

/** GET /api/privacy/requests. */
export const ListPrivacyRequestsQuery = z.object({
  status: PrivacyRequestStatus.optional(),
  kind: PrivacyRequestKind.optional(),
  /** Only my own requests, also for someone who sees the business's. */
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListPrivacyRequestsQuery = z.input<typeof ListPrivacyRequestsQuery>;

/** An export archive's `manifest.json`. */
export const PrivacyManifest = z.object({
  version: z.literal(1),
  tenantId: z.string(),
  subject: PrivacySubject,
  exportedAt: z.iso.datetime(),
  parts: z.array(z.object({ name: z.string(), rows: z.number().int().min(0) })),
});
export type PrivacyManifest = z.infer<typeof PrivacyManifest>;

/** One processor on a register: the application's or the business's. */
export const RegisterProcessor = z.object({
  name: z.string(),
  purpose: z.string(),
  data: z.array(z.string()),
  location: z.string().nullable(),
  url: z.string().nullable(),
  /** Declared by the application for every business, or added by this business. */
  source: z.enum(['application', 'business']),
});
export type RegisterProcessor = z.infer<typeof RegisterProcessor>;

/** One kind of record that holds personal data, and what erasure and retention do to it. */
export const RegisterRecord = z.object({
  entity: z.string(),
  label: z.string(),
  module: z.string().nullable(),
  purpose: z.string().nullable(),
  fields: z.array(z.object({ name: z.string(), label: z.string() })),
  erase: z.enum(['delete', 'anonymise', 'keep']),
  keepReason: z.string().nullable(),
  retention: z.string().nullable(),
});
export type RegisterRecord = z.infer<typeof RegisterRecord>;

/** One retention rule and its period in this business (null: not applied here). */
export const RegisterRetention = z.object({
  name: z.string(),
  label: z.string(),
  scope: z.enum(['tenant', 'deployment']),
  days: z.number().int().nullable(),
  /** The application's period, before this business's own (null: none). */
  defaultDays: z.number().int().nullable(),
  action: z.string(),
});
export type RegisterRetention = z.infer<typeof RegisterRetention>;

/** GET /api/privacy/register: who holds personal data in this business, and for how long. */
export const PrivacyRegister = z.object({
  fiduciary: z.object({
    tenantId: z.string(),
    name: z.string(),
    grievanceContact: z.string(),
    privacyUrl: z.string().nullable(),
  }),
  /** How requests are answered here. */
  requests: z.object({
    respondWithinDays: z.number().int().nullable(),
    review: z.array(PrivacyRequestKind),
  }),
  processors: z.array(RegisterProcessor),
  records: z.array(RegisterRecord),
  retention: z.array(RegisterRetention),
});
export type PrivacyRegister = z.infer<typeof PrivacyRegister>;
