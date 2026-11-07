import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { CORE_OPTIONS, type Conn, type CoreOptions } from '@hykr/core';
import { type Database, otpChallenges } from '@hykr/db';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNotNull, isNull, lt, or, type SQL, sql } from 'drizzle-orm';

export type OtpRow = typeof otpChallenges.$inferSelect;

/** Who asks for a code: a person with an account, or a WhatsApp contact without one. */
export interface OtpSubject {
  userId?: string | null;
  contactId?: string | null;
}

export interface OtpRequest {
  tenantId: string;
  /** What it is for: 'channel.link', 'acceptance'. Limits count per purpose. */
  purpose: string;
  subject: OtpSubject;
  /** 'whatsapp', 'email', or 'esign' (a provider's signing: no code is made). */
  channel: string;
  /** A wa_id or an email address (a provider's name for 'esign'). */
  address: string;
  ttlMs?: number;
  maxAttempts?: number;
  resource?: { type: string; id: string };
  /** What the code is asked against: compared when it is used. */
  binding?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** What a guess at a code came to. */
export type OtpOutcome = 'ok' | 'wrong' | 'none';

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
/** Codes an hour, per purpose: per person, and per address whoever asks. */
export const OTP_PER_HOUR = 5;

const hashOf = (id: string, code: string) =>
  createHash('sha256').update(`${id}:${code}`).digest('hex');

/** Still usable: not used, not expired. */
const live = () => and(isNull(otpChallenges.consumedAt), gt(otpChallenges.expiresAt, sql`now()`));

/**
 * One-time codes for any purpose (decisions B8, 10): 6 digits from `randomInt`, stored only as
 * sha256(<id>:<code>), compared in constant time; a time to live; attempts spent before each
 * guess is compared, in their own statement, so parallel guesses can't all slip under the limit;
 * used once. At most 5 codes an hour per purpose for one person, and for one address whoever
 * asks: codes cost money and land on someone's phone. Delivering a code is the caller's
 * (`OtpSender`): this service only keeps them.
 */
@Injectable()
export class OtpService {
  private readonly db: Database;

  // The shared database from the core options: nothing here reads the configuration, so the
  // acceptance feature's public service can use it.
  constructor(@Inject(CORE_OPTIONS) core: CoreOptions) {
    this.db = core.db;
  }

  /**
   * Refuse a new code past the purpose's hourly limits (429): per person, and per address
   * unless `perAddress` is false (a provider's name is every signing's address).
   */
  async checkLimits(
    conn: Conn,
    req: OtpRequest,
    opts: { perHour?: number; perAddress?: boolean } = {},
  ): Promise<void> {
    const perHour = opts.perHour ?? OTP_PER_HOUR;
    const subject: SQL[] = [];
    if (req.subject.userId) subject.push(eq(otpChallenges.userId, req.subject.userId));
    if (req.subject.contactId) subject.push(eq(otpChallenges.contactId, req.subject.contactId));
    const mine = or(...subject);
    const [recent] = await conn
      .select({
        mine: mine ? sql<number>`count(*) filter (where ${mine})::int` : sql<number>`0`,
        toAddress: sql<number>`count(*) filter (where ${otpChallenges.address} = ${req.address})::int`,
      })
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.purpose, req.purpose),
          gt(otpChallenges.createdAt, sql`now() - interval '1 hour'`),
        ),
      );
    const toAddress = opts.perAddress === false ? 0 : (recent?.toAddress ?? 0);
    if ((recent?.mine ?? 0) >= perHour || toAddress >= perHour)
      throw new HttpException(
        { error: 'too_many_codes', message: 'Too many codes: try again later' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }

  /** A challenge waiting for its code (none is made yet), within the limits. */
  async create(
    conn: Conn,
    req: OtpRequest,
    opts: { perHour?: number; perAddress?: boolean } = {},
  ): Promise<OtpRow> {
    await this.checkLimits(conn, req, opts);
    const [row] = await conn
      .insert(otpChallenges)
      .values({
        tenantId: req.tenantId,
        purpose: req.purpose,
        userId: req.subject.userId ?? null,
        contactId: req.subject.contactId ?? null,
        channel: req.channel,
        address: req.address,
        maxAttempts: req.maxAttempts ?? OTP_MAX_ATTEMPTS,
        expiresAt: new Date(Date.now() + (req.ttlMs ?? OTP_TTL_MS)),
        resourceType: req.resource?.type ?? null,
        resourceId: req.resource?.id ?? null,
        binding: req.binding ?? null,
        meta: req.meta ?? null,
      })
      .returning();
    return row;
  }

  /**
   * Make a pending challenge's code: its hash is stored, the code is returned once, to be
   * delivered. Null when it has one already, was used or expired (a job run twice sends once).
   * `again`: replace a code nobody has tried yet (a send that failed is retried with a new one).
   */
  async issue(
    id: string,
    opts: { again?: boolean } = {},
  ): Promise<{ row: OtpRow; code: string } | null> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const fresh = opts.again
      ? or(isNull(otpChallenges.codeHash), eq(otpChallenges.attempts, 0))
      : isNull(otpChallenges.codeHash);
    const [row] = await this.db
      .update(otpChallenges)
      .set({ codeHash: hashOf(id, code), issuedAt: new Date() })
      .where(and(eq(otpChallenges.id, id), fresh, live()))
      .returning();
    return row ? { row, code } : null;
  }

  /** A challenge and its code at once (the caller delivers it now). */
  async createAndIssue(req: OtpRequest): Promise<{ row: OtpRow; code: string }> {
    const pending = await this.create(this.db, req);
    const issued = await this.issue(pending.id);
    if (!issued) throw new Error('A new code could not be made');
    return issued;
  }

  async get(id: string, conn: Conn = this.db): Promise<OtpRow | undefined> {
    const [row] = await conn.select().from(otpChallenges).where(eq(otpChallenges.id, id));
    return row;
  }

  /** Add to a challenge's meta (a provider's reference, once it has one). */
  async annotate(id: string, patch: Record<string, unknown>): Promise<OtpRow | undefined> {
    const [row] = await this.db
      .update(otpChallenges)
      .set({
        meta: sql`coalesce(${otpChallenges.meta}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(eq(otpChallenges.id, id))
      .returning();
    return row;
  }

  /** The newest usable challenge for a purpose, person and address. */
  async latest(a: {
    tenantId: string;
    purpose: string;
    subject: OtpSubject;
    address: string;
  }): Promise<OtpRow | undefined> {
    const who = a.subject.userId
      ? eq(otpChallenges.userId, a.subject.userId)
      : a.subject.contactId
        ? eq(otpChallenges.contactId, a.subject.contactId)
        : undefined;
    if (!who) return undefined;
    const [row] = await this.db
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.tenantId, a.tenantId),
          eq(otpChallenges.purpose, a.purpose),
          eq(otpChallenges.address, a.address),
          who,
          isNotNull(otpChallenges.codeHash),
          live(),
        ),
      )
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1);
    return row;
  }

  /**
   * Spend one attempt on a guess, in its own statement on the database (never the caller's
   * transaction, which a refusal rolls back). False when none is left, or it is used, expired,
   * or has no code yet.
   */
  async spend(id: string): Promise<boolean> {
    const [spent] = await this.db
      .update(otpChallenges)
      .set({ attempts: sql`${otpChallenges.attempts} + 1` })
      .where(
        and(
          eq(otpChallenges.id, id),
          isNotNull(otpChallenges.codeHash),
          lt(otpChallenges.attempts, otpChallenges.maxAttempts),
          live(),
        ),
      )
      .returning({ id: otpChallenges.id });
    return !!spent;
  }

  /** Is this the challenge's code? Constant time. */
  matches(row: Pick<OtpRow, 'id' | 'codeHash'>, code: string): boolean {
    if (!row.codeHash) return false;
    const expected = Buffer.from(row.codeHash);
    const given = Buffer.from(hashOf(row.id, code));
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Spend an attempt, then compare: what a guess came to (nothing used yet). */
  async guess(row: Pick<OtpRow, 'id' | 'codeHash'>, code: string): Promise<OtpOutcome> {
    if (!(await this.spend(row.id))) return 'none';
    return this.matches(row, code) ? 'ok' : 'wrong';
  }

  /**
   * Used once, in the caller's transaction: a second correct guess racing this one waits for it
   * and finds it used. False when it was used already (or expired).
   */
  async consume(conn: Conn, id: string): Promise<boolean> {
    const [consumed] = await conn
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(and(eq(otpChallenges.id, id), live()))
      .returning({ id: otpChallenges.id });
    return !!consumed;
  }

  /** Guess and, when right, use it: for a flow with no transaction of its own (linking). */
  async verify(row: Pick<OtpRow, 'id' | 'codeHash'>, code: string): Promise<OtpOutcome> {
    const outcome = await this.guess(row, code);
    if (outcome !== 'ok') return outcome;
    return (await this.consume(this.db, row.id)) ? 'ok' : 'none';
  }
}
