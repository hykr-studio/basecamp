import { type Database, schema, writeAudit } from '@app/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { DB } from '../../infra/db.module.js';
import { ThreadsService } from '../../modules/threads/threads.service.js';

const { handoffs } = schema;
export type Handoff = typeof handoffs.$inferSelect;
export type HandoffReason = 'customer_asked' | 'agent_failed' | 'staff_took' | 'agent_tool';

/**
 * A thread staff have taken from the assistant. While one is open the assistant stays silent
 * on it: messages are saved to the thread for staff, who answer from the back office.
 */
@Injectable()
export class HandoffService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly threads: ThreadsService,
  ) {}

  /** The contact's open (or taken) handoff, if any. */
  async activeFor(contactId: string): Promise<Handoff | undefined> {
    const [row] = await this.db
      .select()
      .from(handoffs)
      .where(and(eq(handoffs.contactId, contactId), ne(handoffs.state, 'closed')));
    return row;
  }

  /** Open one for this contact's conversation (one at a time: a second ask finds the first). */
  async open(
    contact: { id: string; tenantId: string; userId: string | null },
    reason: HandoffReason,
    by?: string,
  ): Promise<Handoff> {
    const active = await this.activeFor(contact.id);
    if (active) return active;
    const thread = await this.threads.current({
      tenantId: contact.tenantId,
      subject: contact.userId
        ? { kind: 'user', userId: contact.userId }
        : { kind: 'contact', contactId: contact.id },
    });
    const [row] = await this.db
      .insert(handoffs)
      .values({
        tenantId: contact.tenantId,
        threadId: thread.id,
        contactId: contact.id,
        reason,
        ...(by ? { state: 'taken' as const, takenBy: by, takenAt: new Date() } : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return (await this.activeFor(contact.id)) as Handoff;
    await writeAudit(this.db, {
      action: 'handoff.opened',
      resourceType: 'handoff',
      resourceId: row.id,
      actorKind: by ? 'user' : 'contact',
      actorId: by ?? contact.id,
      tenantId: contact.tenantId,
      channel: 'whatsapp',
      reason,
    });
    return row;
  }
}
