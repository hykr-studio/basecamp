import {
  type ChannelAdapter,
  type InboundMessage,
  isApprovalPayload,
  type Keyword,
  keywordOf,
  render,
  signApproval,
  verifyApproval,
} from '@app/channels';
import type { Principal } from '@app/contracts';
import { ApprovalService, PrincipalResolver } from '@app/core';
import { type Database, schema, writeAudit } from '@app/db';
import { type Lang, langOf, scriptOf, t } from '@app/i18n';
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { HttpException, Inject, Logger } from '@nestjs/common';
import { DelayedError, type Job, type Queue } from 'bullmq';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';
import { ChatService } from '../../modules/chat/chat.service.js';
import { ThreadsService } from '../../modules/threads/threads.service.js';
import { type Contact, ContactsService } from '../contacts.service.js';
import { HandoffService } from '../handoff/handoff.service.js';
import type { MaintenanceJob } from '../maintenance/maintenance.processor.js';
import { APPROVAL_BUTTON_MS } from '../notify/dispatch.processor.js';
import { NotifyService } from '../notify/notify.service.js';
import { OutboundService } from '../outbound.service.js';
import { QUEUES } from '../queues.js';
import { TenantsService } from '../tenants.service.js';
import { REDIS, WHATSAPP } from './adapter.provider.js';
import { SttService } from './stt.service.js';
import { toRenderTurn } from './turn.js';
import type { InboundJob } from './webhook.controller.js';

const { inboundEvents, contacts, messages, approvals } = schema;
const log = new Logger('WhatsAppInbound');

/** One turn per sender at a time: held for the length of a turn, never forever. */
const LOCK_MS = 120_000;

/** Stored messages come back from JSON: dates as strings. */
const revive = (m: InboundMessage & { at: string | Date }): InboundMessage => ({
  ...m,
  at: new Date(m.at),
});

/** What the person said, as text the agent reads: their words, or the title of what they tapped. */
function wordsOf(m: InboundMessage): string | undefined {
  switch (m.body.kind) {
    case 'text':
      return m.body.text;
    case 'list':
      return m.body.title;
    case 'button':
      return m.body.payload.startsWith('pick:') ? m.body.text : undefined;
    case 'media':
      return m.body.caption;
    default:
      return undefined;
  }
}

/**
 * One sender's messages → one agent turn. Takes a lock per sender (two quick messages are one
 * turn, never two at once), merges a burst, marks it read, finds or creates the contact,
 * records the inbound message (which opens the 24-hour window), runs the same chat service as
 * the app as that contact, and queues the rendered reply as one ordered send.
 */
@Processor(QUEUES.inbound, { concurrency: 10 })
export class InboundProcessor extends WorkerHost {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(WHATSAPP) private readonly wa: ChannelAdapter,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly contacts: ContactsService,
    private readonly outbound: OutboundService,
    private readonly chat: ChatService,
    private readonly resolver: PrincipalResolver,
    private readonly tenants: TenantsService,
    private readonly handoffs: HandoffService,
    private readonly threads: ThreadsService,
    @InjectQueue(QUEUES.maintenance) private readonly maintenance: Queue<MaintenanceJob>,
    private readonly notify: NotifyService,
    private readonly approvals: ApprovalService,
    private readonly stt: SttService,
  ) {
    super();
  }

  async process(job: Job<InboundJob>, token?: string) {
    const [event] = await this.db
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.providerMessageId, job.data.providerMessageId));
    // Gone, or already handled as part of an earlier burst: nothing to do.
    if (!event || event.processedAt) return;

    const lock = `${config.queuePrefix}:wa:lock:${event.phoneNumberId}:${event.from}`;
    if (!(await this.redis.set(lock, job.id ?? '1', 'PX', LOCK_MS, 'NX'))) {
      // Another turn for this person is running: come back when it is done.
      await job.moveToDelayed(Date.now() + 500, token);
      throw new DelayedError();
    }
    try {
      await this.handle(event.phoneNumberId, event.from);
    } finally {
      await this.redis.del(lock);
    }
  }

  /** Everything this sender has sent that is not handled yet, as one turn. */
  private async handle(phoneNumberId: string, from: string) {
    const pending = await this.db
      .select()
      .from(inboundEvents)
      .where(
        and(
          eq(inboundEvents.phoneNumberId, phoneNumberId),
          eq(inboundEvents.from, from),
          isNull(inboundEvents.processedAt),
        ),
      )
      .orderBy(asc(inboundEvents.receivedAt));
    if (pending.length === 0) return;
    const burst = pending.map((e) => revive(e.payload as InboundMessage & { at: string }));
    const last = burst.at(-1) as InboundMessage;

    // Blue ticks while the agent works.
    await this.wa.markRead(phoneNumberId, last.providerMessageId).catch((e) => {
      log.warn(`could not mark read: ${e instanceof Error ? e.message : e}`);
    });

    const tenantId = await this.contacts.tenantOfNumber(phoneNumberId);
    if (!tenantId) {
      log.warn(`message to ${phoneNumberId}, which belongs to no business: claim it first`);
      await this.done(
        pending.map((e) => e.id),
        'unknown number',
      );
      return;
    }
    const contact = await this.contacts.findOrCreate(tenantId, from, last.profileName);
    // Voice notes become their words; the audio is dropped once heard.
    let unheard = false;
    for (const [i, m] of burst.entries()) {
      if (m.body.kind !== 'audio') continue;
      const heard = await this.hear(m.body.mediaId, m.body.mime, phoneNumberId);
      if (heard) burst[i] = { ...m, body: { kind: 'text', text: heard } };
      else unheard = true;
    }
    // The inbound messages, recorded: this is what opens (and extends) the 24-hour window.
    await this.db
      .insert(messages)
      .values(
        burst.map((m) => ({
          tenantId,
          contactId: contact.id,
          direction: 'in' as const,
          providerMessageId: m.providerMessageId,
          kind: m.body.kind === 'text' ? ('text' as const) : ('interactive' as const),
          status: 'received' as const,
          at: m.at,
        })),
      )
      .onConflictDoNothing();

    const text = burst
      .flatMap((m) => wordsOf(m) ?? [])
      .join('\n')
      .trim();
    const lang = await this.languageOf(contact, text);
    const target = { tenantId, contactId: contact.id, from: phoneNumberId };
    const business = await this.tenants.get(tenantId);
    const say = (line: string) =>
      this.outbound.queue(target, [{ kind: 'text', to: from, text: line }]);
    if (unheard) await say(t(lang, 'channel.notHeard'));

    // A new customer hears once who we are, and the privacy notice, before the answer.
    if (!contact.welcomedAt && !contact.userId) {
      await say(
        t(lang, 'channel.welcome', {
          name: contact.profileName ?? '',
          business: business.name,
          privacyUrl: business.settings.privacyUrl ?? `${config.appUrl}/privacy`,
        }),
      );
      await this.contacts.markWelcomed(contact.id);
    }

    // Buttons the code answers, not the agent: Approve / Reject (signed), and a
    // notification's own (snooze, …).
    let handled = 0;
    for (const m of burst) {
      if (m.body.kind !== 'button') continue;
      const { payload } = m.body;
      if (isApprovalPayload(payload)) {
        await say(await this.decideByButton(contact, payload, lang, m.providerMessageId));
        handled++;
      } else if (payload.startsWith('ntf:')) {
        const reply = await this.notify.tapped(contact.id, payload, m.replyTo);
        await say(reply ? reply[lang] : t(lang, 'said.failed'));
        handled++;
      }
    }
    if (handled === burst.length) {
      await this.done(pending.map((e) => e.id));
      return;
    }

    // Keywords are handled by code, never by the agent: one message that is exactly one.
    const keyword = burst.length === 1 ? keywordOf(text) : undefined;
    if (keyword) {
      await this.keyword(keyword, contact, lang, say, business.settings, text);
      await this.done(pending.map((e) => e.id));
      return;
    }

    // Staff have this conversation: save the message for them; the assistant stays silent.
    const handoff = await this.handoffs.activeFor(contact.id);
    if (handoff) {
      if (text)
        await this.threads.append({
          threadId: handoff.threadId,
          role: 'user',
          text,
          channel: 'whatsapp',
          lang,
        });
      await this.done(pending.map((e) => e.id));
      return;
    }

    if (text) await this.converse(contact, text, lang, target);
    await this.done(pending.map((e) => e.id));
  }

  /** STOP, START, HELP, a person, erasure, linking: each with its confirmation. */
  private async keyword(
    keyword: Keyword,
    contact: Contact,
    lang: Lang,
    say: (line: string) => Promise<unknown>,
    settings: { grievanceContact: string; replyTime: string },
    text: string,
  ) {
    const consent = async (topic: 'reminders' | 'marketing', granted: boolean) => {
      await this.contacts.setConsent(contact.id, topic, granted, 'keyword');
      await writeAudit(this.db, {
        action: 'channel.consent.changed',
        resourceType: 'contact',
        resourceId: contact.id,
        actorKind: 'contact',
        actorId: contact.id,
        tenantId: contact.tenantId,
        channel: 'whatsapp',
        after: { topic, granted, source: 'keyword' },
      });
    };
    switch (keyword) {
      case 'stop':
        await consent('reminders', false);
        await consent('marketing', false);
        return say(t(lang, 'channel.stopped'));
      case 'stop_reminders':
        await consent('reminders', false);
        return say(t(lang, 'channel.stoppedReminders'));
      case 'start':
        await consent('reminders', true);
        await this.contacts.markUnreachable(contact.id, false);
        return say(t(lang, 'channel.started'));
      case 'help':
        return say(t(lang, 'channel.help', { grievance: settings.grievanceContact }));
      case 'human': {
        const handoff = await this.handoffs.open(contact, 'customer_asked');
        const reply = t(lang, 'channel.handoff', { replyTime: settings.replyTime });
        // Staff read the thread: what they asked, and what they were told.
        for (const [role, line] of [
          ['user', text],
          ['assistant', reply],
        ] as const)
          await this.threads.append({
            threadId: handoff.threadId,
            role,
            text: line,
            channel: 'whatsapp',
            lang,
          });
        return say(reply);
      }
      case 'delete_my_data':
        // The worker confirms by message, then erases; nothing waits for it here.
        await this.maintenance.add('erase', { kind: 'erase', contactId: contact.id });
        return;
      case 'link_account':
        return say(t(lang, 'channel.linkAccount', { url: `${config.appUrl}/?connect=whatsapp` }));
    }
  }

  /** This contact as a principal: a linked number is its person (on WhatsApp's word). */
  private async principalOf(contact: Contact): Promise<Principal> {
    const standing = await this.resolver.forContact(contact.id, { channel: 'whatsapp' });
    const actorId =
      standing.subject.kind === 'user' ? standing.subject.userId : `contact:${contact.id}`;
    return {
      actor: { kind: 'user', id: actorId, role: 'owner' },
      ...standing,
      scopes: [],
      channel: 'whatsapp',
    };
  }

  /** The agent's turn, as this contact (a linked number acts as its person), and its reply. */
  private async converse(
    contact: Contact,
    text: string,
    lang: Lang,
    target: { tenantId: string; contactId: string; from: string },
  ) {
    const p = await this.principalOf(contact);
    const turn = await this.chat.once(p, {
      message: text,
      surfaces: ['text'],
      timeZone: contact.timeZone,
      lang,
    });
    const rendered = toRenderTurn(turn);
    // What this turn parked, and who decides each: this person here, with buttons; or the
    // business (a customer's request), which they are told has been asked.
    const parked = rendered.approvals.length
      ? await this.db
          .select()
          .from(approvals)
          .where(
            inArray(
              approvals.id,
              rendered.approvals.map((a) => a.id),
            ),
          )
      : [];
    const byId = new Map(parked.map((a) => [a.id, a]));
    const self = p.subject?.kind === 'user' ? p.subject.userId : undefined;
    const forTeam = rendered.approvals.filter((a) => !byId.get(a.id)?.approverUserId);
    if (forTeam.length) {
      rendered.approvals = rendered.approvals.filter((a) => !forTeam.includes(a));
      rendered.reply = [rendered.reply, t(lang, 'approval.askedTeam')].filter(Boolean).join('\n\n');
    }
    const outbound = render(rendered, {
      to: contact.address,
      lang,
      appUrl: config.appUrl,
      approvalButtons: (id) => {
        const a = byId.get(id);
        const here = !a?.approverChannels || a.approverChannels.includes('whatsapp');
        if (!a || !self || a.approverUserId !== self || !here || !config.approvalSecret)
          return undefined;
        const expiresAt = Date.now() + APPROVAL_BUTTON_MS;
        const sign = (approve: boolean) =>
          signApproval(config.approvalSecret, { approvalId: id, approve, expiresAt }, contact.id);
        return { approve: sign(true), reject: sign(false) };
      },
    });
    await this.outbound.queue(target, outbound, { runId: turn.runId });
    await this.redis.del(this.failKey(contact.id));
  }

  /**
   * Approve or Reject, tapped: the token must be genuine, unexpired and sent to this number;
   * then the decision is the same one the app makes (who may decide, where, once).
   */
  private async decideByButton(
    contact: Contact,
    payload: string,
    lang: Lang,
    messageId: string,
  ): Promise<string> {
    const verified = verifyApproval(config.approvalSecret, payload, contact.id);
    if (!config.approvalSecret || !verified.ok)
      return verified.ok || verified.reason === 'invalid'
        ? t(lang, 'approval.notYours')
        : t(lang, 'approval.expired', { url: `${config.appUrl}/approvals` });
    const { approvalId, approve } = verified.decision;
    try {
      const p = await this.principalOf(contact);
      const a = await this.approvals.decide(p, approvalId, approve, `wa:${messageId}`);
      const summary = a.summary ?? '';
      if (a.status === 'approved') return t(lang, 'approval.done', { summary });
      if (a.status === 'rejected') return t(lang, 'approval.rejectedDone', { summary });
      if (a.status === 'expired')
        return t(lang, 'approval.expired', { url: `${config.appUrl}/approvals` });
      return a.failureReason ?? t(lang, 'said.failed');
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      const status = e.getStatus();
      if (status === 409) return t(lang, 'approval.alreadyDecided');
      if (status === 403)
        return t(lang, 'approval.decideInApp', { url: `${config.appUrl}/approvals` });
      return t(lang, 'approval.notYours');
    }
  }

  /**
   * The language to answer in: the script they wrote in (Hindi or Telugu stick to the
   * contact), else the contact's own.
   */
  private async languageOf(contact: Contact, text: string): Promise<Lang> {
    const written = scriptOf(text);
    if (written && written !== 'en') {
      const locale = `${written}-IN`;
      if (contact.locale !== locale)
        await this.db.update(contacts).set({ locale }).where(eq(contacts.id, contact.id));
      return written;
    }
    return langOf(contact.locale);
  }

  /** A voice note's words, or undefined when it can't be heard (said so, not retried). */
  private async hear(
    mediaId: string,
    mime: string,
    phoneNumberId: string,
  ): Promise<string | undefined> {
    try {
      const { bytes } = await this.wa.downloadMedia(mediaId, phoneNumberId);
      const { text } = await this.stt.transcribe(bytes, mime);
      return text || undefined;
    } catch (e) {
      log.warn(`voice note not heard: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  /** Turns that failed in a row for this contact; reset when one succeeds. */
  private failKey = (contactId: string) => `${config.queuePrefix}:wa-fail:${contactId}`;

  private async done(ids: string[], error?: string) {
    await this.db
      .update(inboundEvents)
      .set({ processedAt: new Date(), ...(error ? { error } : {}) })
      .where(inArray(inboundEvents.id, ids));
  }

  /** Out of attempts: say sorry (in their language), and keep the error with the message. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<InboundJob> | undefined, error: Error) {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    log.error(`message ${job.data.providerMessageId} failed: ${error.message}`);
    const [event] = await this.db
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.providerMessageId, job.data.providerMessageId));
    if (!event) return;
    await this.db
      .update(inboundEvents)
      .set({ processedAt: new Date(), error: error.message.slice(0, 500) })
      .where(eq(inboundEvents.id, event.id));
    const tenantId = await this.contacts.tenantOfNumber(event.phoneNumberId);
    const contact = tenantId ? await this.contacts.byAddress(tenantId, event.from) : undefined;
    if (!tenantId || !contact) return;
    const lang = langOf(contact.locale);
    const target = { tenantId, contactId: contact.id, from: event.phoneNumberId };
    // Twice in a row: a person takes over rather than a third apology.
    const failures = await this.redis.incr(this.failKey(contact.id));
    await this.redis.pexpire(this.failKey(contact.id), 24 * 60 * 60 * 1000);
    if (failures >= 2) {
      await this.redis.del(this.failKey(contact.id));
      await this.handoffs.open(contact, 'agent_failed');
      const { settings } = await this.tenants.get(tenantId);
      await this.outbound.queue(target, [
        {
          kind: 'text',
          to: contact.address,
          text: t(lang, 'channel.handoff', { replyTime: settings.replyTime }),
        },
      ]);
      return;
    }
    await this.outbound.queue(target, [
      { kind: 'text', to: contact.address, text: t(lang, 'said.failed') },
    ]);
  }
}
