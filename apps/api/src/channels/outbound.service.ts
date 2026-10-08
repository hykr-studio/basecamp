import type { OutboundMessage, StatusUpdate } from '@app/channels';
import { type Database, schema } from '@app/db';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, like, sql } from 'drizzle-orm';
import { DB } from '../infra/db.module.js';
import { QUEUES } from './queues.js';

const { messages, inboundEvents } = schema;

/** One wa-send job: messages to one contact, sent in order; cursor survives retries. */
export type SendJob = {
  tenantId: string;
  /** None for a message to a number that is not a contact yet (a linking code). */
  contactId: string | null;
  /** The business number to send from. */
  from: string;
  messageIds: string[];
  cursor: number;
};

const kindOf = (m: OutboundMessage): 'text' | 'template' | 'interactive' =>
  m.kind === 'text' ? 'text' : m.kind === 'template' ? 'template' : 'interactive';

/**
 * Everything that leaves goes through here: recorded first (so a crash never loses or doubles
 * a message), then one ordered job, so replies never arrive out of sequence. No feature code
 * calls the WhatsApp API itself.
 */
@Injectable()
export class OutboundService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(QUEUES.send) private readonly sendQueue: Queue<SendJob>,
  ) {}

  async queue(
    target: { tenantId: string; contactId: string | null; from: string },
    outbound: OutboundMessage[],
    meta: {
      runId?: string;
      notification?: string;
      category?: string;
      /** What the notification needs later (its fallback, its buttons). */
      extra?: Record<string, unknown>;
    } = {},
  ): Promise<string[]> {
    if (outbound.length === 0) return [];
    const rows = await this.db
      .insert(messages)
      .values(
        outbound.map((m) => ({
          tenantId: target.tenantId,
          contactId: target.contactId,
          channel: 'whatsapp' as const,
          direction: 'out' as const,
          kind: kindOf(m),
          body: m,
          template: m.kind === 'template' ? m.name : null,
          category: meta.category ?? null,
          status: 'queued' as const,
          runId: meta.runId ?? null,
          notification: meta.notification ?? null,
          meta: meta.extra ?? null,
        })),
      )
      .returning({ id: messages.id });
    const messageIds = rows.map((r) => r.id);
    await this.sendQueue.add(
      'send',
      { ...target, messageIds, cursor: 0 },
      { attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
    );
    return messageIds;
  }

  /**
   * A status webhook: sent, delivered, read or failed. A status for a message whose send is
   * not recorded yet (the webhook won the race) is kept, and applied when the send is.
   */
  async applyStatus(s: StatusUpdate) {
    const updated = await this.db
      .update(messages)
      .set({
        status: s.status,
        statusAt: s.at,
        ...(s.errorCode !== undefined ? { errorCode: s.errorCode } : {}),
      })
      .where(eq(messages.providerMessageId, s.providerMessageId))
      .returning({
        id: messages.id,
        contactId: messages.contactId,
        notification: messages.notification,
      });
    if (updated.length === 0)
      await this.db
        .insert(inboundEvents)
        .values({
          providerMessageId: `status:${s.providerMessageId}:${s.status}`,
          phoneNumberId: '',
          from: '',
          payload: s,
        })
        .onConflictDoNothing();
    return updated[0];
  }

  /** Statuses that arrived before this message's send was recorded. */
  async pendingStatuses(providerMessageId: string): Promise<StatusUpdate[]> {
    const rows = await this.db
      .delete(inboundEvents)
      .where(like(inboundEvents.providerMessageId, `status:${providerMessageId}:%`))
      .returning({ payload: inboundEvents.payload });
    return rows.map((r) => {
      const s = r.payload as StatusUpdate & { at: string };
      return { ...s, at: new Date(s.at) };
    });
  }

  async markSent(id: string, providerMessageId: string) {
    await this.db
      .update(messages)
      .set({ providerMessageId, status: 'sent', statusAt: sql`now()` })
      .where(eq(messages.id, id));
  }

  async markFailed(id: string, errorCode: number | undefined) {
    await this.db
      .update(messages)
      .set({ status: 'failed', statusAt: sql`now()`, errorCode: errorCode ?? null })
      .where(eq(messages.id, id));
  }

  /** A message we sent, by the provider's id (a button tapped on it names it). */
  async byProviderId(providerMessageId: string) {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, providerMessageId));
    return row;
  }

  async load(id: string) {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, id));
    return row;
  }
}
