// Invites by email (iTIP over email, RFC 6047): `calendar.invite` records whom to invite to a
// record; the worker emails each an .ics read as the person who asked, and follows the record:
// a change sends an update (SEQUENCE + 1), a deletion a cancellation (decisions B17, 14 to 17).
// One send at a time per invite, each outcome audited and stored as an event (33 and 34).

import { icsCalendar } from '@hykr/connectors';
import {
  type CalendarInviteOutcome,
  FrameworkCapabilities,
  type InviteInfo,
  type Principal,
  SendInviteSpec,
} from '@hykr/contracts';
import {
  allow,
  type Conn,
  defineCommand,
  deny,
  needsApproval,
  recordEvents,
  systemPrincipal,
  tenantZone,
  toJson,
} from '@hykr/core';
import { calendarInvites, type Database, memberships, tenants, user, writeAudit } from '@hykr/db';
import { isLang, type Lang, t, whenText } from '@hykr/i18n';
import { can, subjectOf } from '@hykr/policy';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { MailerService } from '../../channels/notify/mailer.service.js';
import { config } from '../../config.js';
import type { Jobs, ServerContext } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { JOBS } from '../../queues/define.js';
import { serverContext } from '../../queues/jobs.service.js';
import { CalendarLocks, inviteLock } from './lock.js';
import { CalendarEvent } from './ops.js';
import { memberPrincipal } from './principal.js';
import { contentOf, type EventContent, hashOf, schedulable, uidOf } from './schedulable.js';

const log = new Logger('Invites');

export const INVITES_QUEUE = 'calendar.invites';
export type InviteJob =
  | { kind: 'send'; inviteId: string }
  | { kind: 'follow'; tenantId: string; entity: string; id: string };

type InviteRow = typeof calendarInvites.$inferSelect;
type Values = Record<string, unknown>;

export const inviteInfoOf = (r: InviteRow): InviteInfo => ({
  id: r.id,
  record: { entity: r.resourceType, id: r.resourceId },
  email: r.email,
  name: r.name,
  sequence: r.sequence,
  method: r.method as 'REQUEST' | 'CANCEL',
  status: r.status as InviteInfo['status'],
  error: r.error,
  sentAt: r.sentAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

const notFound = (what: string) =>
  new NotFoundException({ error: 'not_found', message: `No such ${what}` });

/** A recipient, checked in the business: an address, or a member's. */
interface Recipient {
  email: string;
  name: string | null;
  userId: string | null;
}

async function recipientsOf(
  tx: Conn,
  p: Principal,
  to: readonly ({ email: string; name?: string } | { userId: string })[],
): Promise<Recipient[]> {
  const out = new Map<string, Recipient>();
  for (const r of to) {
    if ('email' in r) {
      const email = r.email.trim().toLowerCase();
      out.set(email, { email, name: r.name ?? null, userId: null });
      continue;
    }
    const [m] = await tx
      .select({ email: user.email, name: user.name })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(and(eq(memberships.tenantId, p.tenantId ?? ''), eq(memberships.userId, r.userId)));
    if (!m) throw notFound('recipient');
    out.set(m.email.toLowerCase(), {
      email: m.email.toLowerCase(),
      name: m.name,
      userId: r.userId,
    });
  }
  return [...out.values()];
}

/** The principal's own email: an invite to yourself needs nothing more. */
async function ownEmail(tx: Conn, p: Principal): Promise<string | null> {
  const s = subjectOf(p);
  if (s?.kind !== 'user') return null;
  const [u] = await tx.select({ email: user.email }).from(user).where(eq(user.id, s.userId));
  return u?.email.toLowerCase() ?? null;
}

interface InviteLoaded {
  entity: string;
  content: EventContent | null;
  recipients: Recipient[];
  self: boolean;
}

/**
 * calendar.invite: whom to invite to a record. The record is read as the person (404 if they
 * cannot); the emails leave from the worker (decisions B17, 14).
 */
export const SendInvite = defineCommand(SendInviteSpec, {
  resource: { type: 'calendarInvite', id: () => null },
  load: async (tx, p, input): Promise<InviteLoaded> => {
    const s = schedulable(input.entity);
    if (!s) throw notFound('record');
    if (p.actor.kind === 'agent' && s.def.spec.expose.get !== 'all')
      throw notFound(s.def.spec.label);
    const row = await s.def.repo.find(tx, p, input.id);
    if (!row) throw notFound(s.def.spec.label);
    const content = contentOf(s.trait, toJson(s.def.toRead(row, p)) as Values);
    const recipients = await recipientsOf(tx, p, input.to);
    const mine = await ownEmail(tx, p);
    return {
      entity: s.def.name,
      content,
      recipients,
      self: !!mine && recipients.every((r) => r.email === mine),
    };
  },
  authorize: (p, { content, self }) => {
    if (subjectOf(p)?.kind !== 'user')
      return deny('members_invite', 'Only members of the business send invites');
    if (!content) return deny('no_time', 'This record has no time to invite anyone to');
    if (self) return allow('invite_self', 'Whoever reads a record may add it to their calendar');
    if (!can(p, FrameworkCapabilities.messageCustomers))
      return deny('cannot_invite_others', 'Only the business sends invites to others');
    if (p.actor.kind === 'agent')
      return needsApproval('agent_sends_invite', 'Sending an invite for you needs your approval');
    return allow('person_invites', 'The business invites people to its records');
  },
  summarize: (input, { content, recipients }) =>
    `Invite ${recipients.map((r) => r.email).join(', ')} to ${content?.title ?? input.entity}`,
  run: async ({ tx, principal: p, input, loaded }) => {
    const s = subjectOf(p);
    const requestedBy = s?.kind === 'user' ? s.userId : null;
    const rows: InviteRow[] = [];
    for (const r of loaded.recipients) {
      const [row] = await tx
        .insert(calendarInvites)
        .values({
          tenantId: p.tenantId as string,
          resourceType: loaded.entity,
          resourceId: input.id,
          email: r.email,
          name: r.name,
          userId: r.userId,
          lang: input.lang ?? 'en',
          requestedBy,
        })
        .onConflictDoUpdate({
          target: [
            calendarInvites.tenantId,
            calendarInvites.resourceType,
            calendarInvites.resourceId,
            calendarInvites.email,
          ],
          set: {
            name: r.name,
            userId: r.userId,
            lang: input.lang ?? 'en',
            requestedBy,
            status: 'queued',
            error: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      rows.push(row);
    }
    return {
      value: rows,
      touched: rows.map((r) => ({
        type: 'calendarInvite',
        id: r.id,
        change: 'created' as const,
        after: { record: { entity: r.resourceType, id: r.resourceId }, email: r.email },
      })),
      events: rows.map(
        (r) =>
          new CalendarEvent(
            'calendar.invite_requested',
            { id: r.id, tenantId: r.tenantId, entity: r.resourceType, recordId: r.resourceId },
            'calendarInvite',
          ),
      ),
    };
  },
  present: (rows: InviteRow[]) => ({ invites: rows.map(inviteInfoOf) }),
});

/** What an invite showed last: enough to cancel it after the record is gone. */
type Sent = EventContent;

/** Whether the record now says something else than the invite that went. */
const changedSince = (row: InviteRow, content: EventContent | null) =>
  content ? row.method === 'CANCEL' || hashOf(content) !== row.sentHash : row.method === 'REQUEST';

/** The sender address in `SMTP_FROM` ("Name <a@b>" or "a@b"). */
function fromAddress(): string {
  const m = /<([^>]+)>/.exec(config.smtp.from);
  return (m ? m[1] : config.smtp.from).trim();
}

@Injectable()
export class InvitesService {
  private readonly ctx: ServerContext;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(JOBS) private readonly jobs: Jobs,
    @Inject(CalendarLocks) private readonly locks: CalendarLocks,
    @Inject(ModuleRef) ref: ModuleRef,
  ) {
    this.ctx = serverContext(ref);
  }

  queueSend(inviteId: string, key: string) {
    return this.jobs.add<InviteJob>(
      INVITES_QUEUE,
      { kind: 'send', inviteId },
      { name: 'send', jobId: `calendar-invite--${inviteId}--${key}` },
    );
  }

  queueFollow(tenantId: string, entity: string, id: string, eventId: string) {
    return this.jobs.add<InviteJob>(
      INVITES_QUEUE,
      { kind: 'follow', tenantId, entity, id },
      { name: 'follow', jobId: `calendar-follow--${eventId}` },
    );
  }

  run(job: InviteJob, lastTry: boolean): Promise<string> {
    return job.kind === 'send'
      ? this.send(job.inviteId, lastTry)
      : this.follow(job.tenantId, job.entity, job.id, lastTry);
  }

  /** A record's invites, for whoever reads it: in full with `customers.message`, else their own. */
  async list(p: Principal, entity: string, id: string): Promise<InviteInfo[]> {
    const s = schedulable(entity);
    if (!s) throw notFound('record');
    if (p.actor.kind === 'agent' && s.def.spec.expose.get !== 'all')
      throw notFound(s.def.spec.label);
    if (!(await s.def.repo.find(this.db, p, id))) throw notFound(s.def.spec.label);
    const subject = subjectOf(p);
    const all = can(p, FrameworkCapabilities.messageCustomers);
    const rows = await this.db
      .select()
      .from(calendarInvites)
      .where(
        and(
          eq(calendarInvites.tenantId, p.tenantId ?? ''),
          eq(calendarInvites.resourceType, s.def.name),
          eq(calendarInvites.resourceId, id),
          ...(all
            ? []
            : [
                subject?.kind === 'user'
                  ? or(
                      eq(calendarInvites.requestedBy, subject.userId),
                      eq(calendarInvites.userId, subject.userId),
                    )
                  : sql`false`,
              ]),
        ),
      )
      .orderBy(calendarInvites.createdAt);
    return rows.map(inviteInfoOf);
  }

  /** What the record says now, read as the person who asked; null when it is off calendars. */
  private async contentNow(row: InviteRow): Promise<EventContent | null> {
    const s = schedulable(row.resourceType);
    if (!s || !row.requestedBy) return null;
    const p = await memberPrincipal(this.ctx.get, {
      userId: row.requestedBy,
      tenantId: row.tenantId,
    });
    if (!p) return null;
    const found = await s.def.repo.find(this.db, p, row.resourceId);
    return found ? contentOf(s.trait, toJson(s.def.toRead(found, p)) as Values) : null;
  }

  /**
   * After any change to a record: each invite that went out and now says something else goes
   * again (an update, or a cancellation when the record is gone or off calendars), sent by this
   * job, in turn with every other send of the same invite. One still queued is left to its own
   * job, which reads the record when it runs. A send that fails fails the job, which retries.
   */
  async follow(tenantId: string, entity: string, id: string, lastTry = true): Promise<string> {
    const rows = await this.db
      .select({ id: calendarInvites.id })
      .from(calendarInvites)
      .where(
        and(
          eq(calendarInvites.tenantId, tenantId),
          eq(calendarInvites.resourceType, entity),
          eq(calendarInvites.resourceId, id),
          isNotNull(calendarInvites.sentAt),
        ),
      );
    let sent = 0;
    let failure: unknown;
    for (const { id: inviteId } of rows) {
      try {
        if (await this.locks.run(inviteLock(inviteId), () => this.followOne(inviteId, lastTry)))
          sent++;
      } catch (e) {
        failure ??= e;
      }
    }
    if (failure) throw failure;
    return `${sent} updates`;
  }

  /** One invite, under its lock: sent again if the record now says something else. */
  private async followOne(inviteId: string, lastTry: boolean): Promise<boolean> {
    const [row] = await this.db
      .select()
      .from(calendarInvites)
      .where(eq(calendarInvites.id, inviteId));
    // Queued: its own job sends what the record says when it runs. ('sending' here was left by
    // a job that died: what went last is what counts.)
    if (!row?.sentAt || row.status === 'queued') return false;
    const content = await this.contentNow(row);
    if (!changedSince(row, content)) return false;
    const [claimed] = await this.db
      .update(calendarInvites)
      .set({ status: 'sending', updatedAt: new Date() })
      .where(and(eq(calendarInvites.id, row.id), eq(calendarInvites.status, row.status)))
      .returning();
    // Queued for a new invite meanwhile: that job sends it.
    if (!claimed) return false;
    // A retry ends as failed (the next change tries again), never queued with no job to send it.
    await this.deliver(claimed, content, lastTry, 'failed');
    return true;
  }

  /**
   * An invite someone asked for: the record as it is now, emailed as a request, an update or a
   * cancellation, in turn with every other send of the same invite.
   */
  send(inviteId: string, lastTry: boolean): Promise<string> {
    return this.locks.run(inviteLock(inviteId), async () => {
      // Under the lock, a row still 'sending' was left by a job that died: this one sends it.
      const [row] = await this.db
        .update(calendarInvites)
        .set({ status: 'sending', updatedAt: new Date() })
        .where(
          and(
            eq(calendarInvites.id, inviteId),
            inArray(calendarInvites.status, ['queued', 'sending']),
          ),
        )
        .returning();
      if (!row) return 'not queued';
      return this.deliver(row, await this.contentNow(row), lastTry, 'queued');
    });
  }

  /**
   * The email an invite needs now: the record (a request; an update when something went before
   * and this differs), or a cancellation of what went when the record is gone. A failure that
   * will be retried leaves the row as `retryAs` and throws.
   */
  private async deliver(
    row: InviteRow,
    content: EventContent | null,
    lastTry: boolean,
    retryAs: 'queued' | 'failed',
  ): Promise<string> {
    const sent = row.sent as Sent | null;
    let method: 'REQUEST' | 'CANCEL';
    let sequence = row.sequence;
    let showing: EventContent;
    if (content) {
      method = 'REQUEST';
      // Something went before and this says something else: an update.
      if (row.sentAt && changedSince(row, content)) sequence += 1;
      showing = content;
    } else if (row.sentAt && row.method === 'REQUEST' && sent) {
      method = 'CANCEL';
      sequence += 1;
      showing = sent;
    } else {
      await this.finish(row, {
        status: 'failed',
        error: 'The record is gone or has no time',
      });
      return 'nothing to send';
    }
    try {
      await this.email(row, method, sequence, showing);
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      log.warn(`invite ${row.id}: ${error}`);
      if (lastTry) {
        await this.finish(row, { status: 'failed', error }, { method, sequence });
        return 'failed';
      }
      await this.db
        .update(calendarInvites)
        .set({ status: retryAs, error, updatedAt: new Date() })
        .where(and(eq(calendarInvites.id, row.id), eq(calendarInvites.status, 'sending')));
      throw e;
    }
    await this.finish(row, {
      status: 'sent',
      error: null,
      method,
      sequence,
      sent: showing,
      sentHash: method === 'REQUEST' ? hashOf(showing) : null,
      sentAt: new Date(),
    });
    return method === 'CANCEL' ? 'cancelled' : sequence ? 'updated' : 'sent';
  }

  /**
   * A send's outcome, with its audit row and its stored event, in one transaction. An invite
   * asked for again while this one went stays queued, for its own job.
   */
  private async finish(
    row: InviteRow,
    set: Partial<InviteRow> & { status: 'sent' | 'failed' },
    tried?: { method: 'REQUEST' | 'CANCEL'; sequence: number },
  ) {
    const method = (set.method ?? tried?.method ?? row.method) as CalendarInviteOutcome['method'];
    const sequence = set.sequence ?? tried?.sequence ?? row.sequence;
    const name =
      set.status === 'failed'
        ? 'calendar.invite_failed'
        : method === 'CANCEL'
          ? 'calendar.invite_cancelled'
          : 'calendar.invite_sent';
    const job = 'calendar.invites';
    await this.db.transaction(async (tx) => {
      await tx
        .update(calendarInvites)
        .set({
          ...set,
          status: sql`case when ${calendarInvites.status} = 'queued' then 'queued' else ${set.status} end`,
          updatedAt: new Date(),
        })
        .where(eq(calendarInvites.id, row.id));
      await writeAudit(tx, {
        action: name,
        resourceType: 'calendarInvite',
        resourceId: row.id,
        actorKind: 'system',
        actorId: job,
        tenantId: row.tenantId,
        channel: 'background',
        after: {
          record: { entity: row.resourceType, id: row.resourceId },
          to: row.email,
          method,
          sequence,
          ...(set.error ? { error: set.error } : {}),
        },
      });
      await recordEvents(tx, {
        principal: systemPrincipal({ tenantId: row.tenantId, job }),
        events: [
          new CalendarEvent(
            name,
            {
              id: row.id,
              tenantId: row.tenantId,
              entity: row.resourceType,
              recordId: row.resourceId,
              method,
              sequence,
            } satisfies CalendarInviteOutcome,
            'calendarInvite',
          ),
        ],
      });
    });
  }

  private async email(
    row: InviteRow,
    method: 'REQUEST' | 'CANCEL',
    sequence: number,
    c: EventContent,
  ) {
    const [business] = await this.db
      .select({ name: tenants.name, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, row.tenantId));
    const name = business?.name ?? '';
    const timeZone = tenantZone(business?.settings);
    const lang: Lang = isLang(row.lang) ? row.lang : 'en';
    const ics = icsCalendar({
      method,
      prodId: '-//Basecamp//Calendar invites//EN',
      events: [
        {
          uid: uidOf(row.resourceType, row.resourceId),
          sequence,
          start: c.startsAt,
          end: c.endsAt,
          title: c.title,
          ...(c.description ? { description: c.description } : {}),
          ...(c.location ? { location: c.location } : {}),
          organizer: { email: fromAddress(), ...(name ? { name } : {}) },
          attendees: [{ email: row.email, ...(row.name ? { name: row.name } : {}) }],
        },
      ],
    });
    const vars = { title: c.title, business: name, when: whenText(c.startsAt, timeZone, lang) };
    const update = method === 'REQUEST' && sequence > 0;
    const subject = t(
      lang,
      method === 'CANCEL'
        ? 'calendar.invite.cancelledSubject'
        : update
          ? 'calendar.invite.updatedSubject'
          : 'calendar.invite.subject',
      vars,
    );
    const text = [
      t(
        lang,
        method === 'CANCEL'
          ? 'calendar.invite.cancelledBody'
          : update
            ? 'calendar.invite.updatedBody'
            : 'calendar.invite.body',
        vars,
      ),
      ...(c.location ? [t(lang, 'calendar.invite.where', { place: c.location })] : []),
      ...(method === 'REQUEST' ? [t(lang, 'calendar.invite.add')] : []),
    ].join('\n\n');
    await this.ctx.get(MailerService).send(
      { email: row.email, tenantId: row.tenantId },
      {
        subject,
        text,
        attachments: [
          {
            filename: 'invite.ics',
            content: Buffer.from(ics, 'utf8'),
            contentType: `text/calendar; charset=utf-8; method=${method}`,
          },
        ],
        icalEvent: { method, filename: 'invite.ics', content: ics },
      },
      { notification: 'calendar.invite', extra: { inviteId: row.id, method, sequence } },
    );
  }
}
