// What every business used, for the platform's operators (B19): per business and meter, the
// quantities and credits as A3 recorded them (`usage_events`), and each wallet's balance and what
// came in and went out (`credit_ledger`), over a range. Nothing here reads a plan or a price.
import type { UsageLine, UsageReport, UsageWallet } from '@hykr/contracts';
import { creditLedger, creditWallets, type DbOrTx, tenants, usageEvents } from '@hykr/db';
import { BadRequestException } from '@nestjs/common';
import { and, asc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

const DAY = 86_400_000;
const MAX_DAYS = 366;

export const UsageQuery = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    tenantId: z.uuid().optional(),
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type UsageQuery = z.infer<typeof UsageQuery>;

/** The range: `from` (inclusive) to `to` (exclusive), whole UTC days; the current month by default. */
export function rangeOf(q: Pick<UsageQuery, 'from' | 'to'>): { from: Date; to: Date } {
  const now = new Date();
  const from = q.from
    ? new Date(`${q.from}T00:00:00Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = q.to
    ? new Date(`${q.to}T00:00:00Z`)
    : new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  if (!(to > from))
    throw new BadRequestException({ error: 'invalid_range', reason: '`to` must be after `from`' });
  if (to.getTime() - from.getTime() > MAX_DAYS * DAY)
    throw new BadRequestException({
      error: 'invalid_range',
      reason: `A report covers ${MAX_DAYS} days at most`,
    });
  return { from, to };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Sum one list of lines by meter. */
function totalOf(lines: readonly UsageLine[]): UsageLine[] {
  const by = new Map<string, UsageLine>();
  for (const l of lines) {
    const t = by.get(l.meter) ?? { meter: l.meter, quantity: 0, cost: 0 };
    t.quantity += l.quantity;
    t.cost += l.cost;
    by.set(l.meter, t);
  }
  return [...by.values()].sort((a, b) => a.meter.localeCompare(b.meter));
}

/** One page of businesses (by id), each with its meters and wallet over the range. */
export async function usageReport(db: DbOrTx, q: UsageQuery): Promise<UsageReport> {
  const { from, to } = rangeOf(q);
  const page = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(
      and(
        q.tenantId ? eq(tenants.id, q.tenantId) : undefined,
        q.after ? gt(tenants.id, q.after) : undefined,
      ),
    )
    .orderBy(asc(tenants.id))
    .limit(q.limit + 1);
  const shown = page.slice(0, q.limit);
  const ids = shown.map((t) => t.id);
  if (!ids.length) return { from: day(from), to: day(to), tenants: [], totals: [], next: null };

  const used = await db
    .select({
      tenantId: usageEvents.tenantId,
      meter: usageEvents.meter,
      quantity: sql<string>`sum(${usageEvents.quantity})`,
      cost: sql<string>`sum(${usageEvents.cost})`,
    })
    .from(usageEvents)
    .where(
      and(inArray(usageEvents.tenantId, ids), gte(usageEvents.at, from), lt(usageEvents.at, to)),
    )
    .groupBy(usageEvents.tenantId, usageEvents.meter);
  const moved = await db
    .select({
      tenantId: creditLedger.tenantId,
      kind: creditLedger.kind,
      amount: sql<string>`sum(${creditLedger.amount})`,
    })
    .from(creditLedger)
    .where(
      and(inArray(creditLedger.tenantId, ids), gte(creditLedger.at, from), lt(creditLedger.at, to)),
    )
    .groupBy(creditLedger.tenantId, creditLedger.kind);
  const wallets = await db.select().from(creditWallets).where(inArray(creditWallets.tenantId, ids));

  const meters = new Map<string, UsageLine[]>();
  for (const u of used) {
    const lines = meters.get(u.tenantId) ?? [];
    lines.push({ meter: u.meter, quantity: Number(u.quantity), cost: Number(u.cost) });
    meters.set(u.tenantId, lines);
  }
  const walletOf = new Map<string, UsageWallet>();
  for (const w of wallets)
    walletOf.set(w.tenantId, {
      currency: w.currency,
      balance: w.balance,
      topups: 0,
      grants: 0,
      debits: 0,
    });
  for (const m of moved) {
    const w = walletOf.get(m.tenantId);
    if (!w) continue;
    const amount = Number(m.amount);
    if (m.kind === 'topup') w.topups += amount;
    else if (m.kind === 'grant') w.grants += amount;
    // Debits are stored negative: reported as what went out.
    else if (m.kind === 'debit') w.debits += -amount;
  }
  const rows = shown.map((t) => ({
    tenantId: t.id,
    name: t.name,
    meters: totalOf(meters.get(t.id) ?? []),
    wallet: walletOf.get(t.id) ?? null,
  }));
  return {
    from: day(from),
    to: day(to),
    tenants: rows,
    totals: totalOf(rows.flatMap((r) => r.meters)),
    next: page.length > q.limit ? (shown.at(-1)?.id ?? null) : null,
  };
}
