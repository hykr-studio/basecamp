import { z } from 'zod';
import { Channel } from './voice.js';

/** @deprecated The actor's role is replaced by the tenant roles below; kept for old payloads. */
export const Role = z.enum(['admin', 'ops', 'owner', 'operator', 'builder', 'agent']);

/**
 * What someone may do in a business (a tenant). A person can hold several: the business
 * owner, ops (sees and decides for the whole tenant), staff, and customer (their own records).
 */
export const TenantRole = z.enum(['owner', 'admin', 'ops', 'staff', 'customer']);
export type TenantRole = z.infer<typeof TenantRole>;

/**
 * How sure we are who this is: a signed-in session, or only a WhatsApp number (WhatsApp vouches
 * for the number, nothing more). Ordered: anything needing 'session' refuses 'whatsapp_number'.
 */
export const Assurance = z.enum(['whatsapp_number', 'session']);
export type Assurance = z.infer<typeof Assurance>;
export const ASSURANCE_ORDER: readonly Assurance[] = ['whatsapp_number', 'session'];
export const atLeast = (have: Assurance | undefined, need: Assurance) =>
  ASSURANCE_ORDER.indexOf(have ?? 'whatsapp_number') >= ASSURANCE_ORDER.indexOf(need);

/** Who an action is for: a person with an account, or a WhatsApp contact without one. */
export const Subject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string() }),
  z.object({ kind: z.literal('contact'), contactId: z.string() }),
]);
export type Subject = z.infer<typeof Subject>;

export const Principal = z.object({
  actor: z.object({ kind: z.enum(['user', 'agent']), id: z.string(), role: Role }),
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
  /** The customer record this principal is, when they act as a customer. */
  customerId: z.string().optional(),
  assurance: Assurance.optional(),
  runId: z.string().optional(),
  agentVersion: z.string().optional(),
  scopes: z.array(z.string()),
  /** Set when a person approved this parked operation; it is being replayed for them. */
  approvedBy: z.string().optional(),
  /** How the turn reached the assistant (app, voice, whatsapp), carried into every audit row. */
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
});
export type TenantSettings = z.infer<typeof TenantSettings>;
