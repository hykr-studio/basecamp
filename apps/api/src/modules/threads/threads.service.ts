import {
  type Channel,
  type Lang,
  type Principal,
  type Subject,
  subjectKey,
  type ThreadMessage,
} from '@app/contracts';
import { type Database, schema } from '@app/db';
import { subjectOf } from '@app/policy';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DB } from '../../infra/db.module.js';

const { threads, threadMessages } = schema;

/** A UI message part saved with a reply: a tool call with its input and output. */
export type SavedPart = { type: string } & Record<string, unknown>;

/** Whose conversation: a person, or a WhatsApp contact without an account, in one business. */
export type ThreadOwner = { tenantId: string; subject: Subject };

/** The conversation's owner, from a principal: whom it acts for, in its business. */
export function threadOwnerOf(p: Principal): ThreadOwner {
  const subject = subjectOf(p);
  if (!subject || !p.tenantId) throw new NotFoundException('No conversation here');
  return { tenantId: p.tenantId, subject };
}

const whose = (o: ThreadOwner) =>
  and(
    eq(threads.tenantId, o.tenantId),
    o.subject.kind === 'user'
      ? eq(threads.ownerId, o.subject.userId)
      : eq(threads.contactId, o.subject.contactId),
  );
const columnsOf = (o: ThreadOwner) => ({
  tenantId: o.tenantId,
  ...(o.subject.kind === 'user'
    ? { ownerId: o.subject.userId }
    : { contactId: o.subject.contactId }),
});

/**
 * Conversations the server keeps, one person each. Every channel (the app, voice, WhatsApp)
 * reads its history from here and saves its turns here, so they all share one conversation.
 */
@Injectable()
export class ThreadsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(owner: ThreadOwner) {
    const [row] = await this.db.insert(threads).values(columnsOf(owner)).returning();
    return row;
  }

  /**
   * The person's most recent thread, or a new one. One at a time per person (an advisory lock
   * for the transaction), so the app loading, a voice session and a WhatsApp message arriving
   * together still find one thread, not three.
   */
  async current(owner: ThreadOwner) {
    const key = `thread:${owner.tenantId}:${subjectKey(owner.subject)}`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
      const [row] = await tx
        .select()
        .from(threads)
        .where(whose(owner))
        .orderBy(desc(threads.updatedAt))
        .limit(1);
      if (row) return row;
      const [created] = await tx.insert(threads).values(columnsOf(owner)).returning();
      return created;
    });
  }

  /** The thread, if it is theirs; otherwise 404 (never a hint that it exists). */
  async owned(threadId: string, owner: ThreadOwner) {
    const [row] = await this.db
      .select()
      .from(threads)
      .where(and(eq(threads.id, threadId), whose(owner)));
    if (!row) throw new NotFoundException('No such thread');
    return row;
  }

  /**
   * The last `n` messages, oldest first, as the model reads them: each reply's text, plus what
   * it did (its tool calls by name), so a reply that only called tools is not lost from context.
   */
  async history(threadId: string, n: number) {
    const rows = await this.db
      .select({ role: threadMessages.role, text: threadMessages.text, parts: threadMessages.parts })
      .from(threadMessages)
      .where(eq(threadMessages.threadId, threadId))
      .orderBy(desc(threadMessages.seq))
      .limit(n);
    return rows
      .reverse()
      .map((r) => {
        const tools = (r.parts as SavedPart[])
          .filter((p) => p.type.startsWith('tool-'))
          .map((p) => p.type.slice(5));
        const did = r.role === 'assistant' && tools.length ? `[called: ${tools.join(', ')}]` : '';
        return { role: r.role, text: [r.text.trim(), did].filter(Boolean).join('\n') };
      })
      .filter((r) => r.text);
  }

  async append(input: {
    threadId: string;
    role: 'user' | 'assistant';
    text: string;
    parts?: SavedPart[];
    channel: Channel;
    lang?: Lang | null;
    runId?: string | null;
  }) {
    const [row] = await this.db
      .insert(threadMessages)
      .values({
        threadId: input.threadId,
        role: input.role,
        text: input.text,
        parts: input.parts ?? [],
        channel: input.channel,
        lang: input.lang ?? null,
        runId: input.runId ?? null,
      })
      .returning();
    // The thread moves to the top; its first words become its title (in one statement, so two
    // turns at once cannot both set it). Whole characters only: no half of an emoji.
    const title = input.role === 'user' ? Array.from(input.text).slice(0, 80).join('') : null;
    await this.db
      .update(threads)
      .set({ updatedAt: new Date(), title: sql`coalesce(${threads.title}, ${title})` })
      .where(eq(threads.id, input.threadId));
    return row;
  }

  /** The latest messages (up to 500), oldest first, as the app renders them: tool parts, then text. */
  async messages(threadId: string): Promise<ThreadMessage[]> {
    const rows = await this.db
      .select()
      .from(threadMessages)
      .where(eq(threadMessages.threadId, threadId))
      .orderBy(desc(threadMessages.seq))
      .limit(500);
    return rows.reverse().map((r) => ({
      id: r.id,
      role: r.role,
      parts: [
        ...(r.role === 'assistant' ? (r.parts as SavedPart[]) : []),
        ...(r.text ? [{ type: 'text', text: r.text }] : []),
      ],
      metadata: {
        runId: r.runId,
        channel: r.channel,
        lang: r.lang,
        createdAt: r.createdAt.toISOString(),
      },
    }));
  }
}
