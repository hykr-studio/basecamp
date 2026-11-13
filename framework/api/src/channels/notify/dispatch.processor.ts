import { type ChannelAdapter, type OutboundMessage, signApproval } from '@hykr/channels';
import { type Principal, rolesOfBusiness, type TenantConfig } from '@hykr/contracts';
import { PrincipalResolver, tenantZone } from '@hykr/core';
import { type Database, schema } from '@hykr/db';
import { langOf } from '@hykr/i18n';
import {
  type NotificationDef,
  quietUntil,
  type Reader,
  type Recipient,
  type Row,
  underMarketingCap,
} from '@hykr/notifications';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { HttpException, Inject, Logger } from '@nestjs/common';
import { EventsHandler, type IEventHandler } from '@nestjs/cqrs';
import type { Job } from 'bullmq';
import { and, arrayOverlaps, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { deliveryChannels, type NotificationMeta } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { runtime } from '../../runtime.js';
import { type Contact, ContactsService } from '../contacts.service.js';
import { DeliveryFailed } from '../events.js';
import { OutboundService } from '../outbound.service.js';
import { QUEUES } from '../queues.js';
import { TemplateSync } from '../templates/template-sync.js';
import { TenantsService } from '../tenants.service.js';
import { WHATSAPP } from '../whatsapp/adapter.provider.js';
import { readAs } from './as-read.js';
import { MailerService } from './mailer.service.js';
import { type DispatchJob, NotifyService, typeFromEvents } from './notify.service.js';
import { partiesTo } from './parties-to.js';
import { TEMPLATE_KEY } from './send-template.command.js';

/** Read when used: this module may load before the application registers. */
const notifications = () => runtime().notifications.notifications;
const templates = () => runtime().notifications.templates;

const log = new Logger('Dispatch');

/** How long an Approve or Reject button works after it is sent. */
export const APPROVAL_BUTTON_MS = 30 * 60_000;

type Resolved = { contact?: Contact; userId?: string; email?: string; reader: Reader };

/**
 * The statuses of a marketing message that count against the contact's weekly cap: sent, or
 * on its way (queued, so two quick sends cannot both pass). Not `failed`.
 */
const MARKETING_SENT = ['queued', 'sent', 'delivered', 'read'] as const;

/** Tries of one registered channel for one recipient before the next channel is tried. */
const CHANNEL_TRIES = 3;
/** The first retry's delay; it doubles each time. */
const CHANNEL_BACKOFF_MS = 5000;

/** A template a person chose to send (notify.send): one customer, WhatsApp only. */
function byHand(key: string): NotificationDef | undefined {
  if (!key.startsWith(TEMPLATE_KEY)) return undefined;
  const template = templates().find((t) => t.name === key.slice(TEMPLATE_KEY.length));
  if (!template) return undefined;
  return {
    key,
    topic: template.category === 'marketing' ? 'marketing' : 'service',
    to: (row) => [{ customerId: row.id }],
    channels: ['whatsapp'],
    whatsapp: { template, params: (row) => (row.params ?? {}) as Record<string, string> },
    dedupe: (row) => `send:${row.id}`,
  };
}

/** What a send keeps to move on to the next channels later: the record as stored. */
const metaOf = (
  def: NotificationDef,
  data: DispatchJob,
  recipient: Recipient,
  next: string[],
): NotificationMeta => ({
  key: def.key,
  dedupe: data.dedupe,
  row: data.row,
  ...(data.resourceType ? { resourceType: data.resourceType } : {}),
  recipient,
  next,
});

/** "Not on WhatsApp" and similar: later sends skip WhatsApp until they write to us again. */
const UNREACHABLE = new Set([131026]);

/**
 * How a notification goes out, decided per recipient, in order: who they are on which
 * channel; consent for its topic; quiet hours; a template approved in their language (or
 * English); the marketing cap. Each channel in its order where it can, the next where it can't.
 * Notifications always use templates: one path, whether or not the 24-hour window is open. What
 * it says to each recipient is built from the record as they may read it.
 */
@Processor(QUEUES.dispatch, { concurrency: 5 })
export class DispatchProcessor extends WorkerHost {
  private readonly templates: TemplateSync;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly contacts: ContactsService,
    private readonly outbound: OutboundService,
    private readonly tenants: TenantsService,
    private readonly mailer: MailerService,
    private readonly notify: NotifyService,
    private readonly resolver: PrincipalResolver,
    @Inject(WHATSAPP) wa: ChannelAdapter,
  ) {
    super();
    this.templates = new TemplateSync(db, wa, config.appUrl);
  }

  async process(job: Job<DispatchJob>) {
    const data = job.data;
    // Rescheduled or cancelled since: a newer one (or none) stands.
    if (!(await this.notify.isCurrent(data))) return 'stale';
    const def = notifications().find((n) => n.key === data.key) ?? byHand(data.key);
    if (!def) return 'unknown notification';

    // The record's type, so each recipient's words read it as they may (an older job, queued
    // without one, takes it from the event the notification names).
    if (!data.resourceType && !data.key.startsWith(TEMPLATE_KEY)) {
      const type = typeFromEvents(def);
      if (type) data.resourceType = type;
    }
    const { settings } = await this.tenants.get(data.tenantId);
    // Quiet hours and every reader without a zone of their own are in the business's zone.
    const timeZone = tenantZone(settings);
    if (def.topic !== 'service') {
      const until = quietUntil(new Date(), { ...settings.quietHours, timeZone });
      if (until) {
        await this.notify.schedule(def, data.row, until, data.resourceType);
        return `quiet hours: moved to ${until.toISOString()}`;
      }
    }
    if (def.when && !def.when(data.row as never)) return 'not now';
    const recipients = data.only
      ? [data.only.recipient as Recipient]
      : await this.expand(data.tenantId, def.to(data.row as never), settings);
    for (const r of recipients)
      await this.deliver(def, data, r, { timeZone, marketingPerWeek: settings.marketingPerWeek });
  }

  /**
   * One recipient: the channels it always goes by as well (`also`, not on a fallback or a retry,
   * which name their channels), then the chain until one reaches them. A channel the
   * notification skips for this row (`channelWhen`) is passed over. The words are built from the
   * record as this recipient may read it.
   */
  private async deliver(
    def: NotificationDef,
    data: DispatchJob,
    recipient: Recipient,
    settings: { timeZone: string; marketingPerWeek: number },
  ) {
    const to = await this.resolve(data.tenantId, recipient, settings.timeZone);
    const seen = await this.seenBy(def, data, to);
    if (!seen) {
      log.warn(`${def.key}: nothing to say to ${JSON.stringify(recipient)}; not sent`);
      return;
    }
    const usable = (channel: string) =>
      def.channelWhen?.[channel as keyof typeof def.channelWhen]?.(data.row as never) ?? true;
    const chain = (data.only?.channels ?? def.channels).filter(usable);
    if (!data.only)
      for (const channel of (def.also ?? []).filter(usable))
        await this.via(channel, def, data, recipient, to, seen, [], settings);
    for (const [i, channel] of chain.entries())
      if (await this.via(channel, def, data, recipient, to, seen, chain.slice(i + 1), settings))
        return;
    if (chain.length) log.warn(`${def.key}: no channel could reach ${JSON.stringify(recipient)}`);
  }

  /** One channel for one recipient. Returns whether it is taken care of there. */
  private async via(
    channel: string,
    def: NotificationDef,
    data: DispatchJob,
    recipient: Recipient,
    to: Resolved,
    seen: Row,
    next: string[],
    settings: { marketingPerWeek: number },
  ): Promise<boolean> {
    if (channel === 'whatsapp')
      return this.viaWhatsApp(def, data, recipient, to, seen, next, settings);
    if (channel !== 'email')
      return this.viaRegistered(channel, def, data, recipient, to, seen, next);
    if (!to.email || !def.email) return false;
    await this.mailer.send(
      { email: to.email, tenantId: data.tenantId, contactId: to.contact?.id },
      {
        subject: def.email.subject(seen as never, to.reader),
        text: def.email.body(seen as never, to.reader),
      },
      { notification: def.key },
    );
    return true;
  }

  /**
   * The record as this recipient may read it, for the words (decisions H1): their principal in
   * the business (a person who is no longer there, or nobody we can name, reads nothing), and
   * the row through the record's read schema, field policy and read projectors. A template sent
   * by hand carries the sender's own parameters: as they are.
   */
  private async seenBy(def: NotificationDef, data: DispatchJob, to: Resolved): Promise<Row | null> {
    if (def.key.startsWith(TEMPLATE_KEY) && !notifications().some((n) => n.key === def.key))
      return data.row;
    if (!data.resourceType) return null;
    const reader = await this.readerOf(data.tenantId, to);
    return reader ? readAs(data.resourceType, data.row, reader) : null;
  }

  /** Who a recipient is in this business, as a principal that reads. */
  private async readerOf(tenantId: string, to: Resolved): Promise<Principal | null> {
    try {
      if (to.userId) {
        const standing = await this.resolver.forUser(to.userId, { tenantId, channel: 'app' });
        return { actor: { kind: 'user', id: to.userId }, ...standing, scopes: [], channel: 'app' };
      }
      if (to.contact) {
        const standing = await this.resolver.forContact(to.contact.id, { tenantId });
        return {
          actor: { kind: 'agent', id: 'notify' },
          actingFor: { contactId: to.contact.id },
          ...standing,
          scopes: [],
          channel: 'whatsapp',
        };
      }
    } catch (e) {
      // Not in this business (any more), or unknown: they read nothing of it. Anything else
      // (the database) fails the job, which is tried again.
      if (!(e instanceof HttpException)) throw e;
    }
    return null;
  }

  /**
   * A registered delivery channel (push, in-app). Sent: done. Unavailable, or failed for good:
   * the next channel, now. Failed for now: this channel and the rest again later, for this one
   * recipient, up to CHANNEL_TRIES; then the next channel. Returns whether it is taken care of.
   */
  private async viaRegistered(
    name: string,
    def: NotificationDef,
    data: DispatchJob,
    recipient: Recipient,
    to: Resolved,
    seen: Row,
    next: string[],
  ): Promise<boolean> {
    const channel = deliveryChannels.get(name);
    if (!channel) {
      log.error(`${def.key}: no delivery channel is registered as ${name}`);
      return false;
    }
    const outcome = await channel.deliver({
      tenantId: data.tenantId,
      notification: def,
      to: {
        ...(to.userId ? { userId: to.userId } : {}),
        ...(to.contact ? { contactId: to.contact.id } : {}),
      },
      reader: to.reader,
      row: seen,
      dedupe: data.dedupe,
      meta: metaOf(def, data, recipient, next),
    });
    if (outcome.status === 'sent') return true;
    if (outcome.status === 'unavailable' || outcome.final) {
      if (outcome.status === 'failed') log.warn(`${def.key} by ${name} failed: ${outcome.reason}`);
      return false;
    }
    const attempt = (data.attempt ?? 0) + 1;
    if (attempt >= CHANNEL_TRIES) {
      log.warn(`${def.key} by ${name} failed ${attempt} times: ${outcome.reason}`);
      return false;
    }
    await this.notify.retry(
      {
        ...data,
        only: { channels: [name, ...next], recipient: recipient as Record<string, string> },
        attempt,
      },
      CHANNEL_BACKOFF_MS * 2 ** (attempt - 1),
      name,
    );
    return true;
  }

  private async viaWhatsApp(
    def: NotificationDef,
    data: DispatchJob,
    recipient: Recipient,
    to: Resolved,
    seen: Row,
    next: string[],
    settings: { marketingPerWeek: number },
  ): Promise<boolean> {
    const contact = to.contact;
    if (!def.whatsapp || !contact || contact.unreachableAt) return false;
    if (!(await this.contacts.consent(contact.id, def.topic))) return false;
    if (def.topic === 'marketing') {
      // What went out or is on its way. A message a credits pause refused, or one the provider
      // failed, never reached the contact, so it uses none of the week's cap.
      const [sent] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.contactId, contact.id),
            eq(schema.messages.category, 'marketing'),
            inArray(schema.messages.status, MARKETING_SENT),
            gt(schema.messages.at, sql`now() - interval '7 days'`),
          ),
        );
      if (!underMarketingCap(sent?.n ?? 0, settings.marketingPerWeek)) {
        log.log(
          `${def.key}: marketing cap reached for contact ${contact.id}: ${sent?.n ?? 0} of ${settings.marketingPerWeek} this week`,
        );
        return false;
      }
    }
    // Approve and Reject need the secret to sign them; without it, the app decides.
    if (def.approval && !config.approvalSecret) return false;
    const template = def.whatsapp.template;
    const lang = (await this.templates.approved(template.name, to.reader.lang))
      ? to.reader.lang
      : (await this.templates.approved(template.name, 'en'))
        ? 'en'
        : undefined;
    if (!lang) {
      log.warn(`${def.key}: ${template.name} is not approved; trying the next channel`);
      return false;
    }
    const from = await this.contacts.numberOfTenant(data.tenantId);
    if (!from) return false;
    const params = def.whatsapp.params(seen as never, { ...to.reader, lang });
    const message: OutboundMessage = {
      kind: 'template',
      to: contact.address,
      name: template.name,
      language: lang,
      params,
      buttons: (template.buttons ?? []).map((b) =>
        b.type === 'quick_reply'
          ? { payload: this.payloadOf(def, data.row, b.id, contact.id) }
          : { urlParam: params[template.urlParam ?? ''] ?? '' },
      ),
    };
    await this.outbound.queue({ tenantId: data.tenantId, contactId: contact.id, from }, [message], {
      notification: def.key,
      category: template.category,
      extra: { ...metaOf(def, data, recipient, next) },
    });
    return true;
  }

  /**
   * What a quick reply sends back: a signed decision for an approval's buttons (bound to this
   * contact, valid 30 minutes), otherwise `ntf:<notification>:<button>`.
   */
  private payloadOf(
    def: NotificationDef,
    row: DispatchJob['row'],
    button: string,
    contactId: string,
  ) {
    const approvalId = def.approval?.(row as never);
    if (approvalId && (button === 'approve' || button === 'reject'))
      return signApproval(
        config.approvalSecret ?? '',
        { approvalId, approve: button === 'approve', expiresAt: Date.now() + APPROVAL_BUTTON_MS },
        contactId,
      );
    return `ntf:${def.key}:${button}`;
  }

  /**
   * Recipients that name many people, as each one: every member of the business whose roles hold
   * the capability there (the declared roles with the business's edits, and its own roles), and
   * every person of a party or of the parties on a record (`partiesTo`). Each once, without the
   * ones a capability recipient leaves out (the requester of an approval decides nothing of
   * their own).
   */
  private async expand(
    tenantId: string,
    recipients: Recipient[],
    settings: TenantConfig,
  ): Promise<Recipient[]> {
    const out: Recipient[] = [];
    const seen = new Set<string>();
    const business = rolesOfBusiness(settings);
    for (const r of recipients) {
      if ('partyId' in r || 'participantsOf' in r) {
        for (const to of await partiesTo(this.db, tenantId, r)) {
          const key = 'userId' in to ? to.userId : `contact:${to.contactId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(to);
        }
        continue;
      }
      if (!('capability' in r)) {
        out.push(r);
        continue;
      }
      const roles = business
        .filter((x) => x.capabilities.includes(r.capability))
        .map((x) => x.name);
      if (!roles.length) continue;
      const members = await this.db
        .select({ userId: schema.memberships.userId })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.tenantId, tenantId),
            arrayOverlaps(schema.memberships.roles, roles),
          ),
        );
      for (const m of members) {
        if (r.except?.includes(m.userId) || seen.has(m.userId)) continue;
        seen.add(m.userId);
        out.push({ userId: m.userId });
      }
    }
    return out;
  }

  /** Who a recipient is on each channel, and how they read. */
  private async resolve(tenantId: string, r: Recipient, timeZone: string): Promise<Resolved> {
    const { contacts, customers, user } = schema;
    let contact: Contact | undefined;
    let userId: string | null | undefined;
    if ('contactId' in r) {
      contact = await this.contacts.byId(r.contactId);
      userId = contact?.userId;
    } else if ('customerId' in r) {
      const [c] = await this.db.select().from(customers).where(eq(customers.id, r.customerId));
      [contact] = await this.db
        .select()
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.customerId, r.customerId)));
      userId = c?.userId;
    } else if ('userId' in r) {
      userId = r.userId;
      [contact] = await this.db
        .select()
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.userId, r.userId)))
        .orderBy(desc(contacts.linkedAt))
        .limit(1);
    }
    const [person] = userId
      ? await this.db.select({ email: user.email }).from(user).where(eq(user.id, userId))
      : [];
    return {
      contact,
      ...(userId ? { userId } : {}),
      email: person?.email,
      reader: {
        lang: langOf(contact?.locale),
        timeZone: contact?.timeZone ?? timeZone,
        appUrl: config.appUrl,
      },
    };
  }
}

/** WhatsApp failed for good: the notification it carried moves to its next channel. */
@EventsHandler(DeliveryFailed)
export class DeliveryFallback implements IEventHandler<DeliveryFailed> {
  constructor(
    private readonly outbound: OutboundService,
    private readonly contacts: ContactsService,
    private readonly notify: NotifyService,
  ) {}

  async handle(e: DeliveryFailed) {
    if (e.errorCode !== undefined && UNREACHABLE.has(e.errorCode))
      await this.contacts.markUnreachable(e.contactId, true);
    const row = await this.outbound.load(e.messageId);
    const meta = row?.meta as NotificationMeta | null;
    if (!row || !meta?.next.length) return;
    await this.notify.fallback(meta, e.messageId);
  }
}
