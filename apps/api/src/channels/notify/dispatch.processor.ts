import { type ChannelAdapter, type OutboundMessage, signApproval } from '@app/channels';
import { type Database, schema } from '@app/db';
import { langOf } from '@app/i18n';
import {
  type NotificationDef,
  notifications,
  quietUntil,
  type Reader,
  type Recipient,
  templates,
  underMarketingCap,
} from '@app/notifications';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { EventsHandler, type IEventHandler } from '@nestjs/cqrs';
import type { Job, Queue } from 'bullmq';
import { and, arrayOverlaps, desc, eq, gt, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';
import { type Contact, ContactsService } from '../contacts.service.js';
import { DeliveryFailed } from '../events.js';
import { OutboundService } from '../outbound.service.js';
import { QUEUES } from '../queues.js';
import { TemplateSync } from '../templates/template-sync.js';
import { TenantsService } from '../tenants.service.js';
import { WHATSAPP } from '../whatsapp/adapter.provider.js';
import { MailerService } from './mailer.service.js';
import { type DispatchJob, jobIdOf, NotifyService } from './notify.service.js';
import { TEMPLATE_KEY } from './send-template.command.js';

const log = new Logger('Dispatch');

/** How long an Approve or Reject button works after it is sent. */
export const APPROVAL_BUTTON_MS = 30 * 60_000;

/** What a notification needs to move on, kept with the WhatsApp message it went as. */
export type NotificationMeta = {
  key: string;
  dedupe: string;
  row: DispatchJob['row'];
  recipient: Record<string, string>;
  /** The channels still to try if this one fails for good. */
  next: ('whatsapp' | 'email')[];
};

type Resolved = { contact?: Contact; email?: string; reader: Reader };

/** A template a person chose to send (notify.send): one customer, WhatsApp only. */
function byHand(key: string): NotificationDef | undefined {
  if (!key.startsWith(TEMPLATE_KEY)) return undefined;
  const template = templates.find((t) => t.name === key.slice(TEMPLATE_KEY.length));
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

/** "Not on WhatsApp" and similar: later sends skip WhatsApp until they write to us again. */
const UNREACHABLE = new Set([131026]);

/**
 * How a notification goes out, decided per recipient, in order: who they are on which
 * channel; consent for its topic; quiet hours; a template approved in their language (or
 * English); the marketing cap. WhatsApp first where it can, the next channel where it can't.
 * Notifications always use templates: one path, whether or not the 24-hour window is open.
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
    @Inject(WHATSAPP) wa: ChannelAdapter,
  ) {
    super();
    this.templates = new TemplateSync(db, wa, config.appUrl);
  }

  async process(job: Job<DispatchJob>) {
    const data = job.data;
    // Rescheduled or cancelled since: a newer one (or none) stands.
    if (!(await this.notify.isCurrent(data))) return 'stale';
    const def = notifications.find((n) => n.key === data.key) ?? byHand(data.key);
    if (!def) return 'unknown notification';

    const { settings } = await this.tenants.get(data.tenantId);
    if (def.topic !== 'service') {
      const until = quietUntil(new Date(), { ...settings.quietHours, timeZone: settings.timeZone });
      if (until) {
        await this.notify.schedule(def, data.row, until);
        return `quiet hours: moved to ${until.toISOString()}`;
      }
    }
    if (def.when && !def.when(data.row as never)) return 'not now';
    const recipients = data.only
      ? [data.only.recipient as Recipient]
      : await this.expand(data.tenantId, def.to(data.row as never));
    for (const r of recipients)
      await this.deliver(def, data, r, data.only?.channels ?? def.channels, settings);
  }

  private async deliver(
    def: NotificationDef,
    data: DispatchJob,
    recipient: Recipient,
    channels: ('whatsapp' | 'email')[],
    settings: { timeZone: string; marketingPerWeek: number },
  ) {
    const to = await this.resolve(data.tenantId, recipient, settings.timeZone);
    for (const [i, channel] of channels.entries()) {
      const next = channels.slice(i + 1);
      if (
        channel === 'whatsapp' &&
        (await this.viaWhatsApp(def, data, recipient, to, next, settings))
      )
        return;
      if (channel === 'email' && to.email && def.email) {
        await this.mailer.send(
          { email: to.email, tenantId: data.tenantId, contactId: to.contact?.id },
          {
            subject: def.email.subject(data.row as never, to.reader),
            text: def.email.body(data.row as never, to.reader),
          },
          { notification: def.key },
        );
        return;
      }
    }
    log.warn(`${def.key}: no channel could reach ${JSON.stringify(recipient)}`);
  }

  private async viaWhatsApp(
    def: NotificationDef,
    data: DispatchJob,
    recipient: Recipient,
    to: Resolved,
    next: ('whatsapp' | 'email')[],
    settings: { marketingPerWeek: number },
  ): Promise<boolean> {
    const contact = to.contact;
    if (!contact || contact.unreachableAt) return false;
    if (!(await this.contacts.consent(contact.id, def.topic))) return false;
    if (def.topic === 'marketing') {
      const [sent] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.contactId, contact.id),
            eq(schema.messages.category, 'marketing'),
            gt(schema.messages.at, sql`now() - interval '7 days'`),
          ),
        );
      if (!underMarketingCap(sent?.n ?? 0, settings.marketingPerWeek)) return false;
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
    const params = def.whatsapp.params(data.row as never, { ...to.reader, lang });
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
    const meta: NotificationMeta = {
      key: def.key,
      dedupe: data.dedupe,
      row: data.row,
      recipient: recipient as Record<string, string>,
      next,
    };
    await this.outbound.queue({ tenantId: data.tenantId, contactId: contact.id, from }, [message], {
      notification: def.key,
      category: template.category,
      extra: meta,
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

  /** Everyone in the business holding one of these roles, as people. */
  private async expand(tenantId: string, recipients: Recipient[]): Promise<Recipient[]> {
    const out: Recipient[] = [];
    for (const r of recipients) {
      if (!('roles' in r)) {
        out.push(r);
        continue;
      }
      const members = await this.db
        .select({ userId: schema.memberships.userId })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.tenantId, tenantId),
            arrayOverlaps(schema.memberships.roles, r.roles),
          ),
        );
      out.push(...members.map((m) => ({ userId: m.userId })));
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
      email: person?.email,
      reader: { lang: langOf(contact?.locale), timeZone: contact?.timeZone ?? timeZone },
    };
  }
}

/** WhatsApp failed for good: the notification it carried moves to its next channel. */
@EventsHandler(DeliveryFailed)
export class DeliveryFallback implements IEventHandler<DeliveryFailed> {
  constructor(
    private readonly outbound: OutboundService,
    private readonly contacts: ContactsService,
    @InjectQueue(QUEUES.dispatch) private readonly queue: Queue<DispatchJob>,
  ) {}

  async handle(e: DeliveryFailed) {
    if (e.errorCode !== undefined && UNREACHABLE.has(e.errorCode))
      await this.contacts.markUnreachable(e.contactId, true);
    const row = await this.outbound.load(e.messageId);
    const meta = row?.meta as NotificationMeta | null;
    if (!row || !meta?.next.length) return;
    await this.queue.add(
      'fallback',
      {
        key: meta.key,
        tenantId: row.tenantId,
        row: meta.row,
        dedupe: meta.dedupe,
        only: { channels: meta.next, recipient: meta.recipient },
      },
      { jobId: jobIdOf(`${meta.dedupe}:fallback:${e.messageId}`), attempts: 3 },
    );
  }
}
