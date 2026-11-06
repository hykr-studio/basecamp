import { z } from 'zod';
import { Channel } from './voice.js';

/** A role's name: lower case, letters, digits and underscores ('owner', 'site_lead'). */
export const ROLE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * A role someone holds in a business (a tenant): a name from the role registry (`roles` in
 * roles.ts). A person can hold several. A name nobody registered grants nothing.
 */
export const TenantRole = z.string().regex(ROLE_NAME);
export type TenantRole = z.infer<typeof TenantRole>;

/**
 * Who makes the call: a person, an agent acting for one, the server's own background work
 * (`systemPrincipal()` in @hykr/core, never from a request), or a guest holding a share link.
 */
export const ActorKind = z.enum(['user', 'agent', 'system', 'guest']);
export type ActorKind = z.infer<typeof ActorKind>;

/**
 * How sure we are who this is, weakest first: only a WhatsApp number (WhatsApp vouches for
 * the number, nothing more), a one-time code they just entered, or a signed-in session.
 * Anything needing 'session' refuses the other two.
 */
export const Assurance = z.enum(['whatsapp_number', 'otp', 'session']);
export type Assurance = z.infer<typeof Assurance>;
export const ASSURANCE_ORDER: readonly Assurance[] = ['whatsapp_number', 'otp', 'session'];
export const atLeast = (have: Assurance | undefined, need: Assurance) =>
  ASSURANCE_ORDER.indexOf(have ?? 'whatsapp_number') >= ASSURANCE_ORDER.indexOf(need);

/** Who an action is for: a person with an account, or a WhatsApp contact without one. */
export const Subject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string() }),
  z.object({ kind: z.literal('contact'), contactId: z.string() }),
]);
export type Subject = z.infer<typeof Subject>;

export const Principal = z.object({
  actor: z.object({
    kind: ActorKind,
    id: z.string(),
    /** Unused. Only an old line in the WhatsApp inbound processor still sets it (decisions F4). */
    role: z.string().optional(),
  }),
  /** Whom the agent acts for; userId for a person, contactId for a contact without an account. */
  actingFor: z
    .object({ userId: z.string().optional(), contactId: z.string().optional() })
    .optional(),
  /**
   * The person (or contact) the action is for, in the business it happens in. Set by the
   * server (PrincipalGuard), never from a request body or header.
   */
  subject: Subject.optional(),
  tenantId: z.string().optional(),
  roles: z.array(TenantRole).optional(),
  /**
   * What its roles allow in this business, by capability name ('backoffice.use'). Worked out
   * by the server when it resolves the request (or given to `systemPrincipal`), never sent by
   * a client. Absent: nothing. Check it with `can(p, capability)` from @hykr/policy.
   */
  capabilities: z.array(z.string()).optional(),
  /** The customer record this principal is, when they act as a customer. */
  customerId: z.string().optional(),
  assurance: Assurance.optional(),
  runId: z.string().optional(),
  agentVersion: z.string().optional(),
  scopes: z.array(z.string()),
  /** Set when a person approved this parked operation; it is being replayed for them. */
  approvedBy: z.string().optional(),
  /** How the call reached the server (app, voice, whatsapp, mcp…), carried into every audit row. */
  channel: Channel.optional(),
});
export type Principal = z.infer<typeof Principal>;

/** The subject as one string, for keys and audit: "user:abc" or "contact:xyz". */
export const subjectKey = (s: Subject) =>
  s.kind === 'user' ? `user:${s.userId}` : `contact:${s.contactId}`;

/** "user:abc" / "contact:xyz" / a bare user id (the older form) → a subject. */
export function parseSubjectKey(value: string): Subject | undefined {
  const [kind, id] = value.includes(':') ? value.split(/:(.+)/) : ['user', value];
  if (!id) return undefined;
  if (kind === 'user') return { kind: 'user', userId: id };
  if (kind === 'contact') return { kind: 'contact', contactId: id };
  return undefined;
}

/** What the signed-in person is, in the business they are working in (GET /api/me). */
export const Me = z.object({
  userId: z.string(),
  tenantId: z.string(),
  roles: z.array(TenantRole),
  /** What those roles allow here, by name: what a client checks before showing a feature. */
  capabilities: z.array(z.string()),
  customerId: z.string().nullable(),
});
export type Me = z.infer<typeof Me>;

/**
 * How a business works on its channels. Every field has a default, so a new business works
 * as is; the business changes them as it grows.
 */
export const TenantSettings = z.object({
  /** Who to contact about personal data (DPDP grievance officer): named in HELP. */
  grievanceContact: z.string().default('privacy@example.in'),
  privacyUrl: z.string().optional(),
  /** What the handoff message promises, e.g. "2 hours". */
  replyTime: z.string().default('2 hours'),
  /** No reminders or offers between these hours (the business's zone). */
  quietHours: z
    .object({ from: z.string().default('21:00'), to: z.string().default('09:00') })
    .default({ from: '21:00', to: '09:00' }),
  timeZone: z.string().default('Asia/Kolkata'),
  /** Marketing messages per customer per week, at most. */
  marketingPerWeek: z.number().int().min(0).default(1),
  /** Features switched on for this business, by key. A key that is absent is off. */
  features: z.record(z.string(), z.boolean()).default({}),
});
export type TenantSettings = z.infer<typeof TenantSettings>;

/**
 * Is this feature switched on in these settings? Only `true` is on: a key that is absent, or
 * any other value, is off. `TenantConfigService.isEnabled` in @hykr/core reads it per business.
 */
export const featureEnabled = (
  settings: { features?: Readonly<Record<string, unknown>> } | undefined,
  key: string,
): boolean => settings?.features?.[key] === true;
