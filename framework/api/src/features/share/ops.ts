// The share feature's writes (docs/decisions/B9.md), each a WriteOp through runWrite: making a
// link (`share.create`), revoking one (`share.revoke`), a gated link's code (`share.code`) and the
// session the right code opens (`share.verify`), and a public form's answer (the entity's own
// create, `submitOp`). The framework's own operations: they never park and level rules skip them.
import { randomBytes } from 'node:crypto';
import {
  type AuthorizeResult,
  CreateShareInput,
  FrameworkCapabilities,
  maskAddress,
  onBehalfOfKey,
  type Principal,
  type PublicFormDef,
  publicForms,
  ReissueShareInput,
  RenewShareInput,
  type ShareableDef,
  ShareCapabilities,
  ShareCodeInput,
  type ShareLinkInfo,
  type ShareSendChannel,
  type ShareSendInfo,
  type ShareStatus,
  SharesSettings,
  ShareVerifyInput,
  sendOrderOf,
  shareables,
} from '@hykr/contracts';
import {
  type AnyEntityDef,
  allow,
  deny,
  entityDef,
  entityOp,
  needsApproval,
  type RunResult,
  type ShareLinkRow,
  settingsIn,
  shareHash,
  type Tx,
  type WriteOp,
} from '@hykr/core';
import {
  contacts,
  customers,
  type DbOrTx,
  shareLinks,
  shareSends,
  shareSessions,
  tenants,
  user,
} from '@hykr/db';
import { type Lang, pick } from '@hykr/i18n';
import { can, subjectOf } from '@hykr/policy';
import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { OtpRow, OtpService } from '../../channels/otp/otp.service.js';
import { OtpRequested } from '../acceptance/ops.js';
import { requireSecretBox } from '../integrations/settings.js';

type Values = Record<string, unknown>;
const DAY = 24 * 60 * 60 * 1000;

/** What the OTP service calls a share link's codes. */
export const SHARE_PURPOSE = 'share.open';

const notFound = (what: string) =>
  new NotFoundException({ error: 'not_found', message: `No such ${what}` });

const tenantOf = (p: Principal) => {
  if (!p.tenantId) throw notFound('business');
  return p.tenantId;
};

/** A share write: the parts every one of them shares. */
function op<I, L, V>(o: {
  name: string;
  input: z.ZodType<I>;
  resourceId: (input: I, loaded: L) => string | null;
  load: (tx: Tx, p: Principal, input: I) => Promise<L>;
  authorize: (p: Principal, loaded: L, input: I) => AuthorizeResult;
  summarize: (input: I, loaded: L) => string;
  run: WriteOp<I, L, V>['run'];
  present: (value: V, p: Principal) => unknown;
  args?: Values;
  /** Default true: the framework's own operation (no level rules). An assistant's draft is not. */
  system?: boolean;
}): WriteOp<I, L, V> {
  return { kind: 'command', resourceType: 'shareLink', system: true, ...o };
}

/* ── A share's events: ids and states only, never a token or an address ────── */

export class ShareEvent {
  readonly resourceId: string;
  constructor(
    readonly eventName: string,
    readonly row: { id: string; tenantId: string } & Values,
    readonly resourceType = 'shareSend',
  ) {
    this.resourceId = row.id;
  }
}

/** What a send's token is sealed for: this business and this send only. */
export const sendAad = (tenantId: string, sendId: string) => `share-send:${tenantId}:${sendId}`;

export type ShareSendRow = typeof shareSends.$inferSelect;

/** A send as the team sees it: where it went masked, never its token. */
export const sendInfoOf = (r: ShareSendRow): ShareSendInfo => ({
  id: r.id,
  channel: r.channel,
  sentTo: r.address ? maskAddress(r.address) : null,
  status: r.status,
  error: r.error,
  sentAt: r.sentAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

/* ── Presenting a link ─────────────────────────────────────────────────────── */

export function statusOf(row: ShareLinkRow, now = new Date()): ShareStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt <= now) return 'expired';
  if (row.maxUses !== null && row.uses >= row.maxUses) return 'used';
  return 'active';
}

export const targetOf = (row: ShareLinkRow): ShareLinkInfo['target'] =>
  row.kind === 'form'
    ? { form: row.form ?? '' }
    : row.kind === 'page'
      ? { page: row.resourceId ?? '' }
      : { entity: row.resourceType ?? '', id: row.resourceId ?? '' };

/** A link as the team sees it: never its token; where its code goes, masked. */
export function infoOf(row: ShareLinkRow, sends?: ShareSendRow[]): ShareLinkInfo {
  return {
    id: row.id,
    kind: row.kind,
    target: targetOf(row),
    label: row.label,
    status: statusOf(row),
    otp:
      row.otpChannel && row.otpAddress
        ? { channel: row.otpChannel, sentTo: maskAddress(row.otpAddress) }
        : null,
    to:
      row.contactId || row.customerId || row.email
        ? { contactId: row.contactId, customerId: row.customerId, email: row.email }
        : null,
    uses: row.uses,
    maxUses: row.maxUses,
    views: row.views,
    lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    onBehalfOf: row.onBehalfOf,
    createdAt: row.createdAt.toISOString(),
    ...(sends ? { sends: sends.map(sendInfoOf) } : {}),
  };
}

/** The latest sends of these links, newest first, a few each. */
export async function sendsOf(tx: DbOrTx, linkIds: string[]): Promise<Map<string, ShareSendRow[]>> {
  const out = new Map<string, ShareSendRow[]>();
  if (!linkIds.length) return out;
  const rows = await tx
    .select()
    .from(shareSends)
    .where(inArray(shareSends.linkId, linkIds))
    .orderBy(desc(shareSends.createdAt));
  for (const r of rows) {
    const list = out.get(r.linkId) ?? [];
    if (list.length < 5) list.push(r);
    out.set(r.linkId, list);
  }
  return out;
}

/* ── How long a link lasts ─────────────────────────────────────────────────── */

/** What a declaration lets a link to it be: its own cap, and whether it may have no end. */
type LinkPolicy = Pick<ShareableDef, 'otp' | 'maxDays' | 'lasting' | 'send'>;

/**
 * The days a link lasts, or null for no end; or the refusal. No end only where the declaration
 * says `lasting` and the business allows it (`shares.allowLasting`): anything else is too long.
 */
export function daysFor(
  settings: SharesSettings,
  policy: LinkPolicy,
  asked: number | null | undefined,
): { days: number | null } | { refused: AuthorizeResult } {
  const max = Math.min(settings.maxDays, policy.maxDays ?? Number.POSITIVE_INFINITY);
  if (asked === null)
    return policy.lasting && settings.allowLasting
      ? { days: null }
      : { refused: deny('too_long', `A link here ends: at most ${max} days`) };
  const days = asked ?? Math.min(settings.defaultDays, max);
  if (days > max) return { refused: deny('too_long', `A link lasts at most ${max} days here`) };
  return { days };
}

/** When a link of these days ends: never past support access it was made under (S1). */
function endOf(p: Principal, days: number | null): Date | null {
  const until =
    p.onBehalfOf?.kind === 'support' ? Date.parse(p.onBehalfOf.until) : Number.POSITIVE_INFINITY;
  const end = days === null ? Number.POSITIVE_INFINITY : Date.now() + days * DAY;
  const at = Math.min(end, until);
  return Number.isFinite(at) ? new Date(at) : null;
}

/** The declaration a link was made under: its shareable or its form (a page has none). */
function policyOfLink(row: ShareLinkRow): LinkPolicy {
  if (row.kind === 'form') return (row.form ? publicForms.get(row.form) : undefined) ?? {};
  if (row.kind === 'record')
    return (row.resourceType ? shareables.get(row.resourceType) : undefined) ?? {};
  return {};
}

/* ── share.create ──────────────────────────────────────────────────────────── */

/** Whom a link is for, as the business holds them: where a code can go, who signs. */
interface Recipient {
  contactId: string | null;
  customerId: string | null;
  whatsapp: string | null;
  email: string | null;
  /** How the team calls them (an approval card's line). */
  name: string | null;
}

interface CreateLoaded {
  kind: 'record' | 'page' | 'form';
  resourceType: string | null;
  resourceId: string | null;
  form: string | null;
  policy: LinkPolicy;
  recipient: Recipient | null;
  settings: SharesSettings;
  /** What the approval card names: the record, its recipient. */
  names: { target: string; recipient: string | null };
}

/** The recipient a link names, in this business (404 otherwise). */
async function recipientOf(
  tx: Tx,
  tenantId: string,
  to: z.output<typeof CreateShareInput>['to'],
  /** The shared record as stored, for `{ recordCustomer: true }`. */
  row?: Values,
): Promise<Recipient | null> {
  if (!to) return null;
  if ('email' in to)
    return { contactId: null, customerId: null, whatsapp: null, email: to.email, name: to.email };
  // The record's own customer, when it has one: a link for nobody in particular otherwise.
  if ('recordCustomer' in to) {
    const customerId = typeof row?.customerId === 'string' ? row.customerId : undefined;
    return customerId ? recipientOf(tx, tenantId, { customerId }) : null;
  }
  if ('contactId' in to) {
    const [c] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, to.contactId), eq(contacts.tenantId, tenantId)));
    if (!c) throw notFound('contact');
    return {
      contactId: c.id,
      customerId: c.customerId,
      whatsapp: c.address,
      email: null,
      name: c.profileName ?? null,
    };
  }
  const [c] = await tx
    .select({
      id: customers.id,
      contactId: customers.contactId,
      address: contacts.address,
      email: user.email,
      name: customers.displayName,
    })
    .from(customers)
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .leftJoin(user, eq(user.id, customers.userId))
    .where(and(eq(customers.id, to.customerId), eq(customers.tenantId, tenantId)));
  if (!c) throw notFound('customer');
  return {
    contactId: c.contactId,
    customerId: c.id,
    whatsapp: c.address ?? null,
    email: c.email ?? null,
    name: c.name,
  };
}

/** The record a link would open, reached by the person making it (404 otherwise). */
async function reachedRecord(tx: Tx, p: Principal, entity: string, id: string) {
  const shareable = shareables.get(entity);
  const def = shareable ? entityDef(entity) : undefined;
  if (!shareable || !def) throw notFound('record to share');
  const row = (await def.repo.find(tx, p, id)) as Values | undefined;
  if (!row) throw notFound(def.spec.label);
  return { def, shareable, row };
}

/** A record's title for an approval card: its title, name or number, else its kind. */
function titleOf(def: AnyEntityDef, row: Values): string {
  const v = row.title ?? row.name ?? row.number;
  return typeof v === 'string' && v.trim() ? `${def.spec.label} "${v.trim()}"` : def.spec.label;
}

/** The channels a send of this declaration may go by. */
const channelsOf = (policy: LinkPolicy): ShareSendChannel[] => sendOrderOf(policy.send);

/**
 * Who may ask for a link to be sent: its maker (making it now, or the link's maker), anyone else
 * holding `customers.message`; the assistant always waits for its person's approval.
 */
function sendDecision(
  p: Principal,
  policy: LinkPolicy,
  send: { channel?: ShareSendChannel },
  maker: boolean,
): AuthorizeResult | null {
  if (send.channel && !channelsOf(policy).includes(send.channel))
    return deny('channel_unavailable', `A link to this is not sent by ${send.channel}`);
  if (!maker && !can(p, FrameworkCapabilities.messageCustomers))
    return deny('cannot_send_to_others', 'Only the business sends links to others');
  if (p.actor.kind === 'agent')
    return needsApproval('agent_sends_share', 'Links the assistant sends need approval');
  return null;
}

/** A send of a new link: queued, its token sealed for this row only, until it has gone. */
async function queueSend(
  tx: Tx,
  p: Principal,
  link: ShareLinkRow,
  token: string,
  channel: ShareSendChannel | undefined,
) {
  const box = requireSecretBox();
  // A customer first: it brings its contact's number and its account's email, so a send that
  // cannot go on WhatsApp still goes by email.
  const recipient: Record<string, string> = link.customerId
    ? { customerId: link.customerId }
    : link.contactId
      ? { contactId: link.contactId }
      : { email: link.email ?? '' };
  const subject = subjectOf(p);
  const [row] = await tx
    .insert(shareSends)
    .values({
      tenantId: link.tenantId,
      linkId: link.id,
      recipient,
      channel: channel ?? null,
      status: 'queued',
      requestedBy: subject?.kind === 'user' ? subject.userId : null,
    })
    .returning();
  const [sealed] = await tx
    .update(shareSends)
    .set({ tokenSealed: box.seal(token, sendAad(link.tenantId, row.id)) })
    .where(eq(shareSends.id, row.id))
    .returning();
  return {
    row: sealed,
    touched: {
      type: 'shareSend',
      id: row.id,
      change: 'created' as const,
      after: { linkId: link.id, to: recipient, channel: row.channel, status: row.status },
    },
    event: new ShareEvent('share.send_requested', {
      id: row.id,
      tenantId: row.tenantId,
      linkId: link.id,
    }),
  };
}

/** What a made link answers: its token only to the person who made it, never to the assistant. */
export type Made = { row: ShareLinkRow; token: string; send: ShareSendRow | null; note: string };

/**
 * A link answered to a person: its token (once). To the assistant, and so in its run and any
 * stored answer: the link without its token, its send, and what will happen.
 */
function presentMade({ row, token, send, note }: Made, p: Principal) {
  if (p.actor.kind === 'user') return { ...infoOf(row, send ? [send] : []), token };
  return {
    id: row.id,
    status: 'queued',
    send: send ? sendInfoOf(send) : null,
    message: note,
  };
}

/** What the assistant is told once a send is approved and queued. */
const madeNote = (l: { names: CreateLoaded['names'] }, channel?: ShareSendChannel) =>
  `A link to ${l.names.target} will be sent to ${l.names.recipient ?? 'its recipient'}${
    channel ? ` on ${channel === 'whatsapp' ? 'WhatsApp' : 'email'}` : ''
  }`;

/**
 * share.create. `via: 'draft'` is the assistant's path (POST /api/shares/drafts): it may be asked
 * by the assistant, always sends to a named recipient, waits for its person's approval, and is
 * not the framework's own operation (the application's level rules apply to it). The plain path
 * stays people only.
 */
export function createOp(
  args: { via?: 'draft' } = {},
): WriteOp<z.output<typeof CreateShareInput>, CreateLoaded, Made> {
  const draft = args.via === 'draft';
  return op({
    name: 'share.create',
    ...(draft ? { args: { via: 'draft' }, system: false } : {}),
    input: CreateShareInput,
    resourceId: (_input, l) => l?.resourceId ?? null,
    load: async (tx, p, input) => {
      const tenantId = tenantOf(p);
      const settings = (await settingsIn(tx, tenantId)).shares;
      const t = input.target;
      const loaded = async (): Promise<Omit<CreateLoaded, 'names'> & { target: string }> => {
        if ('entity' in t) {
          const { def, shareable, row } = await reachedRecord(tx, p, t.entity, t.id);
          return {
            kind: 'record',
            resourceType: def.name,
            resourceId: t.id,
            form: null,
            policy: shareable,
            recipient: await recipientOf(tx, tenantId, input.to, row),
            settings,
            target: titleOf(def, row),
          };
        }
        if (input.to && 'recordCustomer' in input.to)
          throw new BadRequestException({
            error: 'no_customer',
            message: 'Only a record has a customer to share it with',
          });
        const recipient = await recipientOf(tx, tenantId, input.to);
        if ('page' in t) {
          const page = entityDef('page');
          const row = page
            ? ((await page.repo.find(tx, p, t.page)) as Values | undefined)
            : undefined;
          if (!row) throw notFound('page');
          return {
            kind: 'page',
            resourceType: 'page',
            resourceId: t.page,
            form: null,
            policy: {},
            recipient,
            settings,
            target: typeof row.name === 'string' ? `the page "${row.name}"` : 'a page',
          };
        }
        const form = publicForms.get(t.form);
        if (!form || !entityDef(form.entity)) throw notFound('form');
        return {
          kind: 'form',
          resourceType: null,
          resourceId: null,
          form: form.name,
          policy: form,
          recipient,
          settings,
          target: `the form "${pick(form.label, 'en')}"`,
        };
      };
      const { target, ...l } = await loaded();
      // A send needs someone to send it to (a form posted on a website has nobody).
      if ((input.send || draft) && !l.recipient)
        throw new BadRequestException({
          error: 'no_recipient',
          message: 'This link has no recipient to send it to',
        });
      return { ...l, names: { target, recipient: l.recipient?.name ?? null } };
    },
    authorize(p, l, input) {
      if (draft ? p.actor.kind !== 'user' && p.actor.kind !== 'agent' : p.actor.kind !== 'user')
        return deny('humans_only', 'Only people can share by link: the assistant cannot');
      // A link is someone's: an assistant drafts one only for a person with an account.
      if (subjectOf(p)?.kind !== 'user')
        return deny('people_only', 'Only a member of the team shares by link');
      if (!can(p, ShareCapabilities.create))
        return deny('shares_create', 'You cannot share by link here');
      const days = daysFor(l.settings, l.policy, input.expiresInDays);
      if ('refused' in days) return days.refused;
      if (l.policy.otp === 'required' && !input.otp)
        return deny('code_needed', 'A link to this asks for a code: choose WhatsApp or email');
      // The record's own customer as the recipient: say what is missing on the record, since
      // there is no recipient to name (the app shows no field for one then).
      const label = l.resourceType ? (entityDef(l.resourceType)?.spec.label ?? 'record') : 'record';
      const ofRecord = !!input.to && 'recordCustomer' in input.to;
      const missing = (what: string) =>
        !ofRecord
          ? `Name a recipient with ${what} for the code`
          : l.recipient
            ? `This ${label}'s customer has no ${what.replace(/^an? /, '')} for the code`
            : `This ${label} has no customer to send the code to: share it without a code`;
      if (input.otp === 'whatsapp' && !l.recipient?.whatsapp)
        return deny('no_whatsapp_number', missing('a WhatsApp number'));
      if (input.otp === 'email' && !l.recipient?.email)
        return deny('no_email', missing('an email'));
      if (input.maxUses !== undefined && l.kind !== 'form')
        return deny('uses_for_forms', 'Only a form link counts its answers');
      const send = input.send ?? (draft ? {} : undefined);
      if (send) {
        // Making it now: the person (or their assistant) is its maker.
        const decided = sendDecision(p, l.policy, send, true);
        if (decided) return decided;
        return allow('shares_create_send', 'Shares what they reach, and sends it to its recipient');
      }
      return allow('shares_create', 'Shares what they reach');
    },
    summarize: (input, l) => {
      const send = input.send ?? (draft ? {} : undefined);
      if (send)
        return `Send a link to ${l.names.target} to ${l.names.recipient ?? 'its recipient'}${
          send.channel
            ? ` on ${send.channel === 'whatsapp' ? 'WhatsApp' : 'email'}`
            : ' on WhatsApp or by email'
        }`;
      return l.kind === 'form'
        ? `Share the form ${l.form}`
        : l.kind === 'page'
          ? 'Share a page'
          : `Share ${l.resourceType} ${'id' in input.target ? input.target.id : ''}`;
    },
    async run({ tx, principal: p, input, loaded: l }) {
      const token = randomBytes(32).toString('base64url');
      const days = daysFor(l.settings, l.policy, input.expiresInDays);
      const otp = input.otp ?? null;
      const [row] = await tx
        .insert(shareLinks)
        .values({
          tenantId: tenantOf(p),
          tokenHash: shareHash(token),
          kind: l.kind,
          resourceType: l.resourceType,
          resourceId: l.resourceId,
          form: l.form,
          label: input.label ?? null,
          createdBy: makerOf(p),
          contactId: l.recipient?.contactId ?? null,
          customerId: l.recipient?.customerId ?? null,
          email: l.recipient?.email ?? null,
          otpChannel: otp,
          otpAddress:
            otp === 'whatsapp'
              ? (l.recipient?.whatsapp ?? null)
              : otp === 'email'
                ? (l.recipient?.email ?? null)
                : null,
          maxUses: input.maxUses ?? null,
          expiresAt: endOf(p, 'days' in days ? days.days : null),
          onBehalfOf: onBehalfOfKey(p.onBehalfOf),
        })
        .returning();
      const send = input.send ?? (draft ? {} : undefined);
      const queued = send ? await queueSend(tx, p, row, token, send.channel) : null;
      // The token is in the answer only: the audit, the events and the database keep its hash
      // (and, for a send, a sealed copy on the send until it has gone).
      return {
        value: { row, token, send: queued?.row ?? null, note: madeNote(l, send?.channel) },
        touched: [
          { type: 'shareLink', id: row.id, change: 'created', after: infoOf(row) },
          ...(queued ? [queued.touched] : []),
        ],
        events: queued ? [queued.event] : [],
      };
    },
    present: presentMade,
  });
}

/** The person a link is made by: the person themself, or the one an assistant acts for. */
function makerOf(p: Principal): string {
  const subject = subjectOf(p);
  if (subject?.kind === 'user') return subject.userId;
  return p.actor.id;
}

/* ── share.revoke ──────────────────────────────────────────────────────────── */

export function revokeOp(id: string): WriteOp<Record<string, never>, ShareLinkRow, ShareLinkRow> {
  return op({
    name: 'share.revoke',
    args: { id },
    input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    resourceId: () => id,
    load: async (tx, p) => {
      const [row] = await tx
        .select()
        .from(shareLinks)
        .where(and(eq(shareLinks.id, id), eq(shareLinks.tenantId, tenantOf(p))))
        .for('update');
      if (!row) throw notFound('link');
      // A link is seen by its maker and by those who manage links: anyone else gets 404.
      if (row.createdBy !== p.actor.id && !can(p, ShareCapabilities.manage)) throw notFound('link');
      return row;
    },
    authorize: (p) =>
      p.actor.kind === 'user'
        ? allow('shares_revoke', 'Revokes a link they made or manage')
        : deny('humans_only', 'Only people can revoke a link'),
    summarize: () => 'Revoke a share link',
    async run({ tx, principal: p, loaded: row }) {
      if (row.revokedAt) return { value: row, touched: [] };
      const [after] = await tx
        .update(shareLinks)
        .set({ revokedAt: new Date(), revokedBy: p.actor.id })
        .where(eq(shareLinks.id, row.id))
        .returning();
      return {
        value: after,
        touched: [
          {
            type: 'shareLink',
            id: row.id,
            change: 'updated',
            before: infoOf(row),
            after: infoOf(after),
          },
        ],
      };
    },
    present: (row) => infoOf(row),
  });
}

/* ── share.renew / share.reissue ───────────────────────────────────────────── */

/** A link its maker or a manager of links may change; anyone else gets 404. Locked. */
async function ownLink(tx: Tx, p: Principal, id: string): Promise<ShareLinkRow> {
  const [row] = await tx
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.id, id), eq(shareLinks.tenantId, tenantOf(p))))
    .for('update');
  if (!row) throw notFound('link');
  const me = subjectOf(p);
  const mine = me?.kind === 'user' && row.createdBy === me.userId;
  if (!mine && !can(p, ShareCapabilities.manage)) throw notFound('link');
  return row;
}

/** A revoked link stays revoked: renew and reissue refuse it. */
const revoked = () => deny('link_revoked', 'This link was withdrawn: make a new one');

/**
 * share.renew: a new end date (or none), the same token, so the address its recipient holds
 * keeps working. An ended link comes back; a revoked one does not.
 */
export function renewOp(
  id: string,
): WriteOp<RenewShareInput, { row: ShareLinkRow; settings: SharesSettings }, ShareLinkRow> {
  return op({
    name: 'share.renew',
    args: { id },
    input: RenewShareInput,
    resourceId: () => id,
    load: async (tx, p) => {
      const row = await ownLink(tx, p, id);
      return { row, settings: (await settingsIn(tx, row.tenantId)).shares };
    },
    authorize(p, { row, settings }, input) {
      if (p.actor.kind !== 'user') return deny('humans_only', 'Only people can renew a link');
      if (row.revokedAt) return revoked();
      const days = daysFor(settings, policyOfLink(row), input.expiresInDays);
      if ('refused' in days) return days.refused;
      return allow('shares_renew', 'Renews a link they made or manage');
    },
    summarize: (input) =>
      input.expiresInDays === null
        ? 'Renew a share link with no end date'
        : `Renew a share link for ${input.expiresInDays} days`,
    async run({ tx, principal: p, input, loaded: { row, settings } }) {
      const days = daysFor(settings, policyOfLink(row), input.expiresInDays);
      // Under support access a link still never outlives it (S1).
      const [after] = await tx
        .update(shareLinks)
        .set({ expiresAt: endOf(p, 'days' in days ? days.days : null) })
        .where(eq(shareLinks.id, row.id))
        .returning();
      return {
        value: after,
        touched: [
          {
            type: 'shareLink',
            id: row.id,
            change: 'updated',
            before: infoOf(row),
            after: infoOf(after),
          },
        ],
      };
    },
    present: (row) => infoOf(row),
  });
}

interface ReissueLoaded {
  row: ShareLinkRow;
  settings: SharesSettings;
  names: CreateLoaded['names'];
}

/**
 * share.reissue: the link revoked and a new one made with the same settings (target, recipient,
 * code, uses, label; the same length, or none for a lasting link), a new token, sent to its
 * recipient when asked. How a lost link, or one made before it could be sent, is sent: its token
 * is kept nowhere, so the new one is. `via: 'draft'` is the assistant's (it always sends, and
 * waits for approval).
 */
export function reissueOp(
  id: string,
  args: { via?: 'draft' } = {},
): WriteOp<ReissueShareInput, ReissueLoaded, Made> {
  const draft = args.via === 'draft';
  return op({
    name: 'share.reissue',
    args: draft ? { id, via: 'draft' } : { id },
    ...(draft ? { system: false } : {}),
    input: ReissueShareInput,
    resourceId: () => id,
    load: async (tx, p, input) => {
      const row = await ownLink(tx, p, id);
      const settings = (await settingsIn(tx, row.tenantId)).shares;
      const recipient =
        row.contactId || row.customerId || row.email
          ? await recipientOf(
              tx,
              row.tenantId,
              row.contactId
                ? { contactId: row.contactId }
                : row.customerId
                  ? { customerId: row.customerId }
                  : { email: row.email ?? '' },
            ).catch(() => null)
          : null;
      if ((input.send || draft) && !recipient)
        throw new BadRequestException({
          error: 'no_recipient',
          message: 'This link has no recipient to send it to',
        });
      const def = row.resourceType ? entityDef(row.resourceType) : undefined;
      const target =
        row.kind === 'form'
          ? `the form "${row.form ? pick(publicForms.get(row.form)?.label ?? { en: row.form }, 'en') : ''}"`
          : row.kind === 'page'
            ? 'a page'
            : (def?.spec.label ?? 'a record');
      return { row, settings, names: { target, recipient: recipient?.name ?? null } };
    },
    authorize(p, { row, settings }, input) {
      if (draft ? p.actor.kind !== 'user' && p.actor.kind !== 'agent' : p.actor.kind !== 'user')
        return deny('humans_only', 'Only people can reissue a link: the assistant cannot');
      if (subjectOf(p)?.kind !== 'user')
        return deny('people_only', 'Only a member of the team shares by link');
      if (!can(p, ShareCapabilities.create))
        return deny('shares_create', 'You cannot share by link here');
      if (row.revokedAt) return revoked();
      const send = input.send ?? (draft ? {} : undefined);
      if (send) {
        const me = subjectOf(p);
        const maker = me?.kind === 'user' && me.userId === row.createdBy;
        const decided = sendDecision(p, policyOfLink(row), send, maker);
        if (decided) return decided;
      }
      // The same length, under today's rules: a lasting link only while the business allows it.
      const days = daysFor(settings, policyOfLink(row), lengthOf(row));
      if ('refused' in days) return days.refused;
      return allow('shares_reissue', 'Reissues a link they made or manage');
    },
    summarize: (input, { names }) => {
      const send = input.send ?? (draft ? {} : undefined);
      return send
        ? `Send a new link to ${names.target} to ${names.recipient ?? 'its recipient'}${
            send.channel ? ` on ${send.channel === 'whatsapp' ? 'WhatsApp' : 'email'}` : ''
          } (the old link stops working)`
        : 'Reissue a share link (the old link stops working)';
    },
    async run({ tx, principal: p, input, loaded: { row, settings, names } }) {
      const now = new Date();
      const [old] = await tx
        .update(shareLinks)
        .set({ revokedAt: now, revokedBy: makerOf(p) })
        .where(eq(shareLinks.id, row.id))
        .returning();
      const token = randomBytes(32).toString('base64url');
      const days = daysFor(settings, policyOfLink(row), lengthOf(row));
      const [made] = await tx
        .insert(shareLinks)
        .values({
          tenantId: row.tenantId,
          tokenHash: shareHash(token),
          kind: row.kind,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          form: row.form,
          label: row.label,
          createdBy: row.createdBy,
          contactId: row.contactId,
          customerId: row.customerId,
          email: row.email,
          otpChannel: row.otpChannel,
          otpAddress: row.otpAddress,
          maxUses: row.maxUses,
          uses: row.uses,
          expiresAt: endOf(p, 'days' in days ? days.days : null),
          onBehalfOf: onBehalfOfKey(p.onBehalfOf),
        })
        .returning();
      const send = input.send ?? (draft ? {} : undefined);
      const queued = send ? await queueSend(tx, p, made, token, send.channel) : null;
      return {
        value: {
          row: made,
          token,
          send: queued?.row ?? null,
          note: madeNote({ names }, send?.channel),
        },
        touched: [
          {
            type: 'shareLink',
            id: row.id,
            change: 'updated',
            before: infoOf(row),
            after: infoOf(old),
          },
          { type: 'shareLink', id: made.id, change: 'created', after: infoOf(made) },
          ...(queued ? [queued.touched] : []),
        ],
        events: queued ? [queued.event] : [],
      };
    },
    present: presentMade,
  });
}

/** How long a link was made to last, in days (null: no end), for its reissue. */
function lengthOf(row: ShareLinkRow): number | null {
  if (!row.expiresAt) return null;
  const days = Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / DAY);
  return Math.min(Math.max(days, 1), 3650);
}

/* ── share.code / share.verify: a gated link's one-time code ────────────────── */

/** What a share code's challenge keeps besides its binding. */
export interface ShareCodeMeta {
  lang: Lang;
  business: string;
  contactId: string | null;
}

export function codeOp(
  otp: OtpService,
  link: ShareLinkRow,
): WriteOp<z.output<typeof ShareCodeInput>, { business: string }, OtpRow> {
  return op({
    name: 'share.code',
    input: ShareCodeInput,
    resourceId: () => link.id,
    load: async (tx) => {
      const [t] = await tx
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, link.tenantId));
      const branded = (t?.settings as { branding?: { name?: string | null } } | null)?.branding;
      return { business: branded?.name ?? t?.name ?? '' };
    },
    authorize: () =>
      link.otpChannel && link.otpAddress
        ? allow('share_code', 'The link asks its recipient for a code')
        : deny('no_code_needed', 'This link asks for no code'),
    summarize: () => 'Ask for a code to open a share link',
    async run({ tx, input, loaded }) {
      const meta: ShareCodeMeta = {
        lang: input.lang ?? 'en',
        business: loaded.business,
        contactId: link.contactId,
      };
      const row = await otp.create(tx, {
        tenantId: link.tenantId,
        purpose: SHARE_PURPOSE,
        subject: { contactId: link.contactId },
        channel: link.otpChannel ?? '',
        address: link.otpAddress ?? '',
        resource: { type: 'shareLink', id: link.id },
        binding: { linkId: link.id },
        meta: meta as unknown as Values,
      });
      return {
        value: row,
        touched: [
          {
            type: 'otpChallenge',
            id: row.id,
            change: 'created',
            after: {
              purpose: row.purpose,
              channel: row.channel,
              sentTo: maskAddress(row.address),
              linkId: link.id,
              expiresAt: row.expiresAt.toISOString(),
            },
          },
        ],
        events: [new OtpRequested(row)],
      };
    },
    present: (row) => ({
      id: row.id,
      channel: row.channel,
      sentTo: maskAddress(row.address),
      expiresAt: row.expiresAt.toISOString(),
    }),
  });
}

/** Is this challenge one of this link's codes? */
export const ofLink = (ch: OtpRow | undefined, link: ShareLinkRow): ch is OtpRow =>
  !!ch &&
  ch.purpose === SHARE_PURPOSE &&
  ch.tenantId === link.tenantId &&
  (ch.binding as { linkId?: string } | null)?.linkId === link.id;

const noCode = () =>
  new BadRequestException({
    error: 'no_code',
    message: 'This code is used or has expired: ask for a new one',
  });

/**
 * The right code (guessed on the pool before this write, as B8 does): it is used, and a session
 * opens for this device, for the business's `shares.sessionHours` or until the link ends.
 */
export function verifyOp(
  otp: OtpService,
  link: ShareLinkRow,
): WriteOp<
  z.output<typeof ShareVerifyInput>,
  { ch: OtpRow; hours: number },
  { session: string; expiresAt: Date }
> {
  return op({
    name: 'share.verify',
    input: ShareVerifyInput,
    resourceId: () => link.id,
    load: async (tx, _p, input) => {
      const ch = await otp.get(input.challengeId, tx);
      if (!ofLink(ch, link)) throw notFound('code');
      return { ch, hours: (await settingsIn(tx, link.tenantId)).shares.sessionHours };
    },
    authorize: () => allow('share_code_right', 'The recipient entered the code sent to them'),
    summarize: () => 'Open a share link with its code',
    async run({ tx, loaded }) {
      if (!(await otp.consume(tx, loaded.ch.id))) throw noCode();
      const session = randomBytes(32).toString('base64url');
      const until = new Date(
        Math.min(
          link.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
          Date.now() + loaded.hours * 60 * 60 * 1000,
        ),
      );
      const [row] = await tx
        .insert(shareSessions)
        .values({
          tenantId: link.tenantId,
          linkId: link.id,
          tokenHash: shareHash(session),
          challengeId: loaded.ch.id,
          expiresAt: until,
        })
        .returning();
      // A session past its end is of no use to anyone: they go as new ones are made.
      await tx
        .delete(shareSessions)
        .where(and(eq(shareSessions.linkId, link.id), lt(shareSessions.expiresAt, new Date())));
      return {
        value: { session, expiresAt: until },
        touched: [
          {
            type: 'shareSession',
            id: row.id,
            change: 'created',
            after: { linkId: link.id, challengeId: loaded.ch.id, expiresAt: until.toISOString() },
          },
        ],
      };
    },
    present: (v) => ({ session: v.session, expiresAt: v.expiresAt.toISOString() }),
  });
}

/* ── A public form's answer ────────────────────────────────────────────────── */

const used = () =>
  new HttpException(
    { error: 'link_used', message: 'This form takes no more answers' },
    HttpStatus.GONE,
  );

/** One answer counted on the link, still live and not used up; or 410. */
async function spendUse(tx: Tx, link: ShareLinkRow): Promise<void> {
  const [hit] = await tx
    .update(shareLinks)
    .set({ uses: sql`${shareLinks.uses} + 1` })
    .where(
      and(
        eq(shareLinks.id, link.id),
        isNull(shareLinks.revokedAt),
        or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, new Date())),
        or(isNull(shareLinks.maxUses), lt(shareLinks.uses, shareLinks.maxUses)),
      ),
    )
    .returning({ id: shareLinks.id });
  if (!hit) throw used();
}

/**
 * Whose record an answer is: the link's customer; the customer of its contact (made for the
 * contact when it has none); or, with no recipient, a new customer record named by the form's
 * `customerName` answer (else the recipient's email, else the form's label).
 */
async function customerFor(
  tx: Tx,
  link: ShareLinkRow,
  form: PublicFormDef,
  values: Values,
): Promise<{ id: string; created: boolean }> {
  if (link.customerId) {
    const [c] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, link.customerId), eq(customers.tenantId, link.tenantId)));
    if (c) return { id: c.id, created: false };
  }
  const named = form.customerName ? String(values[form.customerName] ?? '').trim() : '';
  const displayName = (named || link.email || pick(form.label, 'en')).slice(0, 120);
  if (link.contactId) {
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, link.contactId), eq(contacts.tenantId, link.tenantId)));
    if (contact?.customerId) return { id: contact.customerId, created: false };
    if (contact) {
      const [mine] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.tenantId, link.tenantId), eq(customers.contactId, contact.id)));
      if (mine) return { id: mine.id, created: false };
      const [made] = await tx
        .insert(customers)
        .values({ tenantId: link.tenantId, displayName, contactId: contact.id })
        .returning({ id: customers.id });
      await tx
        .update(contacts)
        .set({ customerId: made.id })
        .where(and(eq(contacts.id, contact.id), isNull(contacts.customerId)));
      return { id: made.id, created: true };
    }
  }
  const [made] = await tx
    .insert(customers)
    .values({ tenantId: link.tenantId, displayName })
    .returning({ id: customers.id });
  return { id: made.id, created: true };
}

type Row = Values & { id: string };

/**
 * A public form's answer: the entity's own create (`<entity>.create`, its rules, plugins,
 * approval and level rules, write hooks and audit), as the guest with `reach: 'form'` and the
 * answer's customer, so the record is owned by the business's default owner and belongs to that
 * customer. The link counts one use in the same transaction. Answers only the new record's id.
 */
export function submitOp(
  def: AnyEntityDef,
  link: ShareLinkRow,
  form: PublicFormDef,
): WriteOp<Values, { customer: { id: string; created: boolean } }, Row> {
  const base = entityOp(def, 'create', null);
  const as = (p: Principal, customerId: string): Principal => ({
    ...p,
    customerId,
    share: { linkId: link.id, reach: 'form' },
  });
  return {
    name: base.name,
    kind: base.kind,
    resourceType: base.resourceType,
    resourceId: () => null,
    input: base.input,
    approval: base.approval,
    load: async (tx, p, input) => {
      await spendUse(tx, link);
      const customer = await customerFor(tx, link, form, input);
      // The create's own load, as the guest `run` writes as: a reference they may not name is
      // refused here, before the answer could park, and the use and the customer roll back (V10).
      await base.load?.(tx, as(p, customer.id), input);
      return { customer };
    },
    authorize: (p, l, input) => base.authorize(as(p, l.customer.id), null, input),
    summarize: (input) => base.summarize(input, null),
    async run({ tx, principal, input, loaded }): Promise<RunResult<Row>> {
      const out = await base.run({
        tx,
        principal: as(principal, loaded.customer.id),
        input,
        loaded: null,
      });
      const madeCustomer = loaded.customer.created
        ? [{ type: 'customer', id: loaded.customer.id, change: 'created' as const }]
        : [];
      return { ...out, touched: [...madeCustomer, ...out.touched] };
    },
    present: (row) => ({ entity: def.name, id: row.id }),
  };
}

/** The public form a link opens, when it is a form's. */
export const formOf = (link: ShareLinkRow) =>
  link.kind === 'form' && link.form ? publicForms.get(link.form) : undefined;
