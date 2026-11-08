// Acceptance and personal data (B18, decisions H4). A copy lists the person's acceptance
// evidence (who signed, where the code went, from which address and device) and the one-time
// codes sent to them. Being forgotten deletes their codes. Their evidence stays:
// `audit.acceptances` is append-only (decisions B8, 14) and is the business's record of what was
// agreed. The erasure counts it as kept, and the register names it with the application's words
// for why.
import type { Subject } from '@hykr/contracts';
import type { Conn } from '@hykr/core';
import { acceptances, otpChallenges, user } from '@hykr/db';
import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import type { ErasureContributor, ExportContributor } from '../../hooks.js';
import { definePersonalDataPart } from '../privacy/registry.js';

/** Why evidence stays on erasure: a code; the application's policy says it in words. */
export const EVIDENCE_KEPT = 'acceptance_evidence';
/** The evidence, as the erasure's outcome and the register name it. */
export const EVIDENCE_PART = 'acceptance.evidence';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The person's account email, lower case: an email code goes to it. */
async function emailOf(conn: Conn, userId: string): Promise<string | null> {
  const [u] = await conn.select({ email: user.email }).from(user).where(eq(user.id, userId));
  return u?.email.trim().toLowerCase() || null;
}

/** The evidence a subject signed, in one business or in all. */
const signedBy = (subject: Subject, tenantId?: string): SQL =>
  and(
    tenantId ? eq(acceptances.tenantId, tenantId) : undefined,
    subject.kind === 'user'
      ? eq(acceptances.signerUserId, subject.userId)
      : eq(acceptances.signerContactId, subject.contactId),
  ) as SQL;

/** The codes sent to a subject: asked by them, or sent to their email. */
async function codesOf(conn: Conn, subject: Subject, tenantId?: string): Promise<SQL> {
  const here = tenantId ? eq(otpChallenges.tenantId, tenantId) : undefined;
  if (subject.kind === 'contact')
    return and(here, eq(otpChallenges.contactId, subject.contactId)) as SQL;
  const email = await emailOf(conn, subject.userId);
  return and(
    here,
    or(
      eq(otpChallenges.userId, subject.userId),
      email
        ? and(eq(otpChallenges.channel, 'email'), sql`lower(${otpChallenges.address}) = ${email}`)
        : undefined,
    ),
  ) as SQL;
}

/**
 * "Delete my data": the person's one-time codes go (the WhatsApp channel's contributor also
 * deletes those sent to a contact's number). The evidence they signed stays, counted as kept.
 */
export const acceptanceErasure: ErasureContributor = {
  name: 'acceptance',
  async erase({ subject, tenantId, tx }) {
    const codes = await tx
      .delete(otpChallenges)
      .where(await codesOf(tx, subject, tenantId))
      .returning({ id: otpChallenges.id });
    const [evidence] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(acceptances)
      .where(signedBy(subject, tenantId));
    return {
      count: codes.length,
      kept: [{ name: EVIDENCE_PART, count: evidence?.n ?? 0, keepReason: EVIDENCE_KEPT }],
    };
  },
};

/** The evidence a subject signed and the codes sent to them, for their data export. */
export const acceptanceExport: ExportContributor = {
  name: 'acceptance',
  async export({ subject, tenantId, db }) {
    const signed = await db
      .select()
      .from(acceptances)
      .where(signedBy(subject, tenantId))
      .orderBy(acceptances.acceptedAt);
    const codes = await db
      .select()
      .from(otpChallenges)
      .where(await codesOf(db, subject, tenantId))
      .orderBy(otpChallenges.createdAt);
    return {
      // Theirs in full: what they agreed to, and what was recorded about them when they did.
      acceptances: signed.map((a) => ({
        id: a.id,
        tenantId: a.tenantId,
        name: a.name,
        method: a.method,
        record: { entity: a.resourceType, id: a.resourceId, version: a.recordVersion },
        document: {
          id: a.documentId,
          name: a.documentName,
          version: a.documentVersion,
          sha256: a.documentSha256,
          fileName: a.documentFileName,
        },
        statement: a.statement,
        lang: a.lang,
        signerName: a.signerName,
        otpChannel: a.otpChannel,
        otpAddress: a.otpAddress,
        otpSentAt: iso(a.otpSentAt),
        otpVerifiedAt: iso(a.otpVerifiedAt),
        esignProvider: a.esignProvider,
        esignRef: a.esignRef,
        esignCertificate: a.esignCertificate,
        ip: a.ip,
        forwardedFor: a.forwardedFor,
        userAgent: a.userAgent,
        device: a.device,
        channel: a.channel,
        assurance: a.assurance,
        acceptedAt: iso(a.acceptedAt),
      })),
      // Never the code's hash.
      otpChallenges: codes.map((c) => ({
        id: c.id,
        tenantId: c.tenantId,
        purpose: c.purpose,
        channel: c.channel,
        address: c.address,
        record: c.resourceType ? { entity: c.resourceType, id: c.resourceId } : null,
        attempts: c.attempts,
        expiresAt: iso(c.expiresAt),
        issuedAt: iso(c.issuedAt),
        consumedAt: iso(c.consumedAt),
        createdAt: iso(c.createdAt),
      })),
    };
  },
};

/** What the register lists of acceptance. */
export const acceptanceParts = [
  definePersonalDataPart({
    name: EVIDENCE_PART,
    label: {
      en: 'Acceptance evidence: who accepted which document, how and from where',
      hi: 'स्वीकृति का प्रमाण: किसने कौन सा दस्तावेज़ कैसे और कहाँ से स्वीकार किया',
      te: 'అంగీకార సాక్ష్యం: ఎవరు ఏ పత్రాన్ని ఎలా, ఎక్కడి నుంచి అంగీకరించారు',
    },
    fields: ['signerName', 'otpAddress', 'ip', 'forwardedFor', 'userAgent', 'device'],
    erase: 'keep',
    keepReason: EVIDENCE_KEPT,
  }),
  definePersonalDataPart({
    name: 'acceptance.codes',
    label: {
      en: 'One-time codes sent',
      hi: 'भेजे गए एक-बार के कोड',
      te: 'పంపిన ఒకసారి కోడ్‌లు',
    },
    fields: ['address'],
    erase: 'delete',
  }),
];
