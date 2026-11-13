// The share feature's writes (docs/decisions/B9.md), each a WriteOp through runWrite: making a
// link (`share.create`), revoking one (`share.revoke`), a gated link's code (`share.code`) and the
// session the right code opens (`share.verify`), and a public form's answer (the entity's own
// create, `submitOp`). The framework's own operations: they never park and level rules skip them.
import { randomBytes } from 'node:crypto';
import {
  type AuthorizeResult,
  CreateShareInput,
  maskAddress,
  onBehalfOfKey,
  type Principal,
  type PublicFormDef,
  publicForms,
  type ShareableDef,
  ShareCapabilities,
  ShareCodeInput,
  type ShareLinkInfo,
  type ShareStatus,
  SharesSettings,
  ShareVerifyInput,
  shareables,
} from '@hykr/contracts';
import {
  type AnyEntityDef,
  allow,
  deny,
  entityDef,
  entityOp,
  type RunResult,
  type ShareLinkRow,
  settingsIn,
  shareHash,
  type Tx,
  type WriteOp,
} from '@hykr/core';
import { contacts, customers, shareLinks, shareSessions, tenants, user } from '@hykr/db';
import { type Lang, pick } from '@hykr/i18n';
import { can } from '@hykr/policy';
import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { OtpRow, OtpService } from '../../channels/otp/otp.service.js';
import { OtpRequested } from '../acceptance/ops.js';

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
}): WriteOp<I, L, V> {
  return { kind: 'command', resourceType: 'shareLink', system: true, ...o };
}

/* ── Presenting a link ─────────────────────────────────────────────────────── */

export function statusOf(row: ShareLinkRow, now = new Date()): ShareStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt <= now) return 'expired';
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
export function infoOf(row: ShareLinkRow): ShareLinkInfo {
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
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    onBehalfOf: row.onBehalfOf,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ── share.create ──────────────────────────────────────────────────────────── */

/** Whom a link is for, as the business holds them: where a code can go, who signs. */
interface Recipient {
  contactId: string | null;
  customerId: string | null;
  whatsapp: string | null;
  email: string | null;
}

interface CreateLoaded {
  kind: 'record' | 'page' | 'form';
  resourceType: string | null;
  resourceId: string | null;
  form: string | null;
  policy: Pick<ShareableDef, 'otp' | 'maxDays'>;
  recipient: Recipient | null;
  settings: SharesSettings;
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
  if ('email' in to) return { contactId: null, customerId: null, whatsapp: null, email: to.email };
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
    return { contactId: c.id, customerId: c.customerId, whatsapp: c.address, email: null };
  }
  const [c] = await tx
    .select({
      id: customers.id,
      contactId: customers.contactId,
      address: contacts.address,
      email: user.email,
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

export function createOp(): WriteOp<
  z.output<typeof CreateShareInput>,
  CreateLoaded,
  {
    row: ShareLinkRow;
    token: string;
  }
> {
  return op({
    name: 'share.create',
    input: CreateShareInput,
    resourceId: (_input, l) => l?.resourceId ?? null,
    load: async (tx, p, input) => {
      const tenantId = tenantOf(p);
      const settings = (await settingsIn(tx, tenantId)).shares;
      const t = input.target;
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
        if (!page || !(await page.repo.find(tx, p, t.page))) throw notFound('page');
        return {
          kind: 'page',
          resourceType: 'page',
          resourceId: t.page,
          form: null,
          policy: {},
          recipient,
          settings,
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
      };
    },
    authorize(p, l, input) {
      if (p.actor.kind !== 'user')
        return deny('humans_only', 'Only people can share by link: the assistant cannot');
      if (!can(p, ShareCapabilities.create))
        return deny('shares_create', 'You cannot share by link here');
      const max = Math.min(l.settings.maxDays, l.policy.maxDays ?? Number.POSITIVE_INFINITY);
      const days = input.expiresInDays ?? Math.min(l.settings.defaultDays, max);
      if (days > max) return deny('too_long', `A link lasts at most ${max} days here`);
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
      return allow('shares_create', 'Shares what they reach');
    },
    summarize: (input, l) =>
      l.kind === 'form'
        ? `Share the form ${l.form}`
        : l.kind === 'page'
          ? 'Share a page'
          : `Share ${l.resourceType} ${'id' in input.target ? input.target.id : ''}`,
    async run({ tx, principal: p, input, loaded: l }) {
      const token = randomBytes(32).toString('base64url');
      const max = Math.min(l.settings.maxDays, l.policy.maxDays ?? Number.POSITIVE_INFINITY);
      const days = input.expiresInDays ?? Math.min(l.settings.defaultDays, max);
      // Made under support access: it never outlives that access (S1).
      const until =
        p.onBehalfOf?.kind === 'support'
          ? Date.parse(p.onBehalfOf.until)
          : Number.POSITIVE_INFINITY;
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
          createdBy: p.actor.id,
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
          expiresAt: new Date(Math.min(Date.now() + days * DAY, until)),
          onBehalfOf: onBehalfOfKey(p.onBehalfOf),
        })
        .returning();
      // The token is in the answer only: the audit and the database keep its hash.
      return {
        value: { row, token },
        touched: [{ type: 'shareLink', id: row.id, change: 'created', after: infoOf(row) }],
      };
    },
    present: ({ row, token }) => ({ ...infoOf(row), token }),
  });
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
        Math.min(link.expiresAt.getTime(), Date.now() + loaded.hours * 60 * 60 * 1000),
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
        gt(shareLinks.expiresAt, new Date()),
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
