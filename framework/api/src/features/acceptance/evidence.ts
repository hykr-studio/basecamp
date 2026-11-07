import { createHash, randomUUID } from 'node:crypto';
import { type AcceptanceInfo, maskAddress, type Principal } from '@hykr/contracts';
import { type Conn, projectRead, type Tx } from '@hykr/core';
import { acceptances } from '@hykr/db';
import { can } from '@hykr/policy';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { AcceptanceEvidenceCapability } from './capability.js';

export type EvidenceRow = typeof acceptances.$inferSelect;
/** What a new evidence row says; its id, place in the chain and hashes are added here. */
export type EvidenceInput = Omit<EvidenceRow, 'id' | 'seq' | 'prevHash' | 'hash' | 'acceptedAt'> & {
  acceptedAt?: Date;
};

/**
 * The fields a row's hash covers, in this order (decisions B8, 15). Adding a column means adding
 * it at the end, and only for rows written after: a row's hash never changes.
 */
const HASHED = [
  'id',
  'tenantId',
  'seq',
  'name',
  'method',
  'resourceType',
  'resourceId',
  'recordVersion',
  'documentId',
  'documentName',
  'documentVersion',
  'documentSha256',
  'documentFileName',
  'statement',
  'lang',
  'signerKind',
  'signerUserId',
  'signerContactId',
  'signerCustomerId',
  'signerName',
  'challengeId',
  'otpChannel',
  'otpAddress',
  'otpSentAt',
  'otpVerifiedAt',
  'esignProvider',
  'esignRef',
  'esignCertificate',
  'ip',
  'forwardedFor',
  'userAgent',
  'device',
  'channel',
  'assurance',
  'requestId',
  'acceptedAt',
  'prevHash',
] as const satisfies readonly (keyof EvidenceRow)[];

/** JSON with object keys sorted at every level and dates as ISO: the same bytes after jsonb. */
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  return value ?? null;
}

/** A row's hash: SHA-256 of its fields (and the previous row's hash) as canonical JSON. */
export function hashOf(row: Omit<EvidenceRow, 'hash'>): string {
  const fields = HASHED.map((k) => [k, canonical(row[k])]);
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/**
 * Write one evidence row, chained to the business's previous one: under a per-business lock in
 * the write's transaction, so two acceptances at once take seq n and n + 1, each naming the other.
 */
export async function recordEvidence(tx: Tx, input: EvidenceInput): Promise<EvidenceRow> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`acceptances:${input.tenantId}`}))`);
  const [last] = await tx
    .select({ seq: acceptances.seq, hash: acceptances.hash })
    .from(acceptances)
    .where(eq(acceptances.tenantId, input.tenantId))
    .orderBy(desc(acceptances.seq))
    .limit(1);
  // Stored to the millisecond, as Date keeps it: the hash read back is the hash written.
  const acceptedAt = new Date(input.acceptedAt?.getTime() ?? Date.now());
  const unhashed: Omit<EvidenceRow, 'hash'> = {
    ...input,
    id: randomUUID(),
    seq: (last?.seq ?? 0) + 1,
    acceptedAt,
    prevHash: last?.hash ?? null,
  };
  const [row] = await tx
    .insert(acceptances)
    .values({ ...unhashed, hash: hashOf(unhashed) })
    .returning();
  return row;
}

/** Does this row still match its hash, and its predecessor's? */
export async function verifyRow(conn: Conn, row: EvidenceRow): Promise<boolean> {
  const { hash, ...rest } = row;
  if (hashOf(rest) !== hash) return false;
  if (row.seq === 1) return row.prevHash === null;
  const [prev] = await conn
    .select({ hash: acceptances.hash })
    .from(acceptances)
    .where(and(eq(acceptances.tenantId, row.tenantId), eq(acceptances.seq, row.seq - 1)));
  return !!prev && prev.hash === row.prevHash;
}

/** The whole chain of one business: every row matches its hash, in order, with no gap. */
export async function verifyChain(
  conn: Conn,
  tenantId: string,
): Promise<{ ok: boolean; rows: number; brokenAt: number | null }> {
  const rows = await conn
    .select()
    .from(acceptances)
    .where(eq(acceptances.tenantId, tenantId))
    .orderBy(asc(acceptances.seq));
  let prev: string | null = null;
  for (const [i, row] of rows.entries()) {
    const { hash, ...rest } = row;
    if (row.seq !== i + 1 || row.prevHash !== prev || hashOf(rest) !== hash)
      return { ok: false, rows: rows.length, brokenAt: row.seq };
    prev = hash;
  }
  return { ok: true, rows: rows.length, brokenAt: null };
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * An evidence row as p may see it: the full address, the request and an e-sign certificate only
 * with `acceptances.evidence`; then the read projectors, as resource type 'acceptance'.
 */
export function presentEvidence(
  row: EvidenceRow,
  p: Principal,
  extra: { verified?: boolean } = {},
): AcceptanceInfo {
  const full = can(p, AcceptanceEvidenceCapability);
  const info: AcceptanceInfo = {
    id: row.id,
    acceptance: row.name,
    method: row.method as AcceptanceInfo['method'],
    record: { entity: row.resourceType, id: row.resourceId, version: row.recordVersion },
    document: {
      id: row.documentId,
      name: row.documentName,
      version: row.documentVersion,
      sha256: row.documentSha256,
      fileName: row.documentFileName,
    },
    statement: row.statement,
    lang: row.lang as AcceptanceInfo['lang'],
    signer: {
      kind: row.signerKind as 'user' | 'contact',
      userId: row.signerUserId,
      contactId: row.signerContactId,
      customerId: row.signerCustomerId,
      name: row.signerName,
    },
    otp:
      row.otpChannel && row.otpAddress
        ? {
            channel: row.otpChannel as 'whatsapp' | 'email',
            sentTo: maskAddress(row.otpAddress),
            ...(full ? { address: row.otpAddress } : {}),
            sentAt: iso(row.otpSentAt),
            verifiedAt: iso(row.otpVerifiedAt),
          }
        : null,
    esign:
      row.esignProvider && row.esignRef
        ? {
            provider: row.esignProvider,
            ref: row.esignRef,
            ...(full ? { certificate: row.esignCertificate ?? null } : {}),
          }
        : null,
    ...(full
      ? {
          client: {
            ip: row.ip,
            forwardedFor: row.forwardedFor,
            userAgent: row.userAgent,
            device: row.device ?? null,
          },
        }
      : {}),
    channel: row.channel,
    acceptedAt: row.acceptedAt.toISOString(),
    seq: row.seq,
    hash: row.hash,
    prevHash: row.prevHash,
    ...(extra.verified !== undefined ? { verified: extra.verified } : {}),
  };
  return projectRead(
    'acceptance',
    info as unknown as Record<string, unknown>,
    p,
  ) as unknown as AcceptanceInfo;
}
