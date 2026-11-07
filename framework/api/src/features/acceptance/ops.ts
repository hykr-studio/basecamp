import {
  AcceptanceChallengeInput,
  type AcceptanceDevice,
  AcceptInput,
  ESignStartInput,
  maskAddress,
  type OtpChannel,
  type Principal,
} from '@hykr/contracts';
import {
  type RunResult,
  systemPrincipal,
  type Touched,
  type Tx,
  tenantOf,
  transition,
  transitionVia,
  type WriteOp,
} from '@hykr/core';
import type { Lang } from '@hykr/i18n';
import { subjectOf } from '@hykr/policy';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { OtpOutcome, OtpRow, OtpService } from '../../channels/otp/otp.service.js';
import {
  ACCEPTANCE_PURPOSE,
  acceptable,
  acceptedBefore,
  addressesOf,
  type Binding,
  bindingOf,
  businessName,
  decide,
  ESIGN_PURPOSE,
  type Resolved,
  resolveFor,
  resolveForSystem,
  type Signer,
  signerOf,
  statementOf,
} from './checks.js';
import { channelsOfAcceptance } from './define.js';
import type { ESignResult } from './esign.js';
import {
  type EvidenceInput,
  type EvidenceRow,
  presentEvidence,
  recordEvidence,
} from './evidence.js';

type Values = Record<string, unknown>;

/** The request an acceptance came with: kept in its evidence (decisions B8, 21). */
export interface ClientInfo {
  ip: string | null;
  forwardedFor: string | null;
  userAgent: string | null;
}

/** What a challenge keeps besides its binding: what was shown, to whom. */
export interface ChallengeMeta {
  statement: string;
  lang: Lang;
  business: string;
  signerName: string | null;
  customerId: string | null;
  /** The contact a WhatsApp code goes to. */
  contactId: string | null;
  /** E-sign only: the provider's reference and where to sign. */
  ref?: string;
  url?: string | null;
  expiresAt?: string | null;
}

/** otp.requested: a code to make and send (ids only: the code is made by whoever sends it). */
export class OtpRequested {
  readonly eventName = 'otp.requested';
  readonly resourceType = 'otpChallenge';
  readonly resourceId: string;
  readonly row: { id: string; tenantId: string; purpose: string; channel: string };
  constructor(row: OtpRow) {
    this.resourceId = row.id;
    this.row = { id: row.id, tenantId: row.tenantId, purpose: row.purpose, channel: row.channel };
  }
}

/** acceptance.recorded: a record's document was accepted (ids, the PDF's version and hash). */
export class AcceptanceRecorded {
  readonly eventName = 'acceptance.recorded';
  readonly resourceType = 'acceptance';
  readonly resourceId: string;
  readonly row: Values;
  constructor(e: EvidenceRow) {
    this.resourceId = e.id;
    this.row = {
      id: e.id,
      tenantId: e.tenantId,
      acceptance: e.name,
      method: e.method,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      recordVersion: e.recordVersion,
      documentId: e.documentId,
      documentVersion: e.documentVersion,
      sha256: e.documentSha256,
    };
  }
}

const OTP_MINUTE = 60_000;
/** How long a signing at a provider may take before it is asked for again. */
const ESIGN_TTL_MS = 24 * 60 * OTP_MINUTE;

/** Is this challenge the principal's own, in their business? */
function theirs(ch: OtpRow | undefined, p: Principal, purpose: string): ch is OtpRow {
  if (!ch || ch.tenantId !== p.tenantId || ch.purpose !== purpose) return false;
  const s = subjectOf(p);
  if (s?.kind === 'user') return ch.userId === s.userId;
  if (s?.kind === 'contact') return ch.contactId === s.contactId;
  return false;
}

/** The record moves (as the business: the signer may only read it), and the app's own work. */
async function follow(
  tx: Tx,
  p: Principal,
  r: Resolved,
  evidence: EvidenceRow,
  via: string,
): Promise<RunResult<EvidenceRow>> {
  const touched: Touched[] = [
    {
      type: 'acceptance',
      id: evidence.id,
      change: 'created',
      after: {
        acceptance: evidence.name,
        method: evidence.method,
        resourceType: evidence.resourceType,
        resourceId: evidence.resourceId,
        recordVersion: evidence.recordVersion,
        documentId: evidence.documentId,
        sha256: evidence.documentSha256,
        signer: { kind: evidence.signerKind, userId: evidence.signerUserId },
      },
    },
  ];
  const events: object[] = [new AcceptanceRecorded(evidence)];
  let row = r.row;
  if (r.def.transition) {
    const business = systemPrincipal({ tenantId: tenantOf(p), job: 'acceptance' });
    const moved = await transition(tx, business, r.entity, r.row, r.def.transition, {
      via: transitionVia(r.entity),
    });
    touched.push(...moved.touched);
    events.push(...moved.events);
    row = moved.row;
  }
  const more = await r.def.accepted?.({
    tx,
    principal: p,
    row,
    evidence: {
      id: evidence.id,
      documentId: evidence.documentId,
      sha256: evidence.documentSha256,
      recordVersion: evidence.recordVersion,
    },
    via: { via },
  });
  if (more) {
    touched.push(...(more.touched ?? []));
    events.push(...(more.events ?? []));
  }
  return { value: evidence, touched, events };
}

/** The evidence's document and record part. */
const documentPart = (r: Resolved, binding: Binding) => ({
  tenantId: r.doc.tenantId,
  name: r.def.name,
  resourceType: r.entity.name,
  resourceId: r.doc.resourceId,
  recordVersion: binding.recordVersion,
  documentId: r.doc.id,
  documentName: r.doc.name,
  documentVersion: r.doc.version,
  documentSha256: r.doc.sha256 ?? binding.sha256,
  documentFileName: r.doc.fileName,
});

/** The decision once a challenge's binding is compared with what is stored now. */
function stillBound(l: { binding: Binding; r: Resolved }) {
  if (l.r.doc.sha256 !== l.binding.sha256)
    return {
      decision: 'deny' as const,
      rule: 'document_changed',
      reason: 'The PDF changed since the code was sent: ask for a new one',
    };
  if (l.r.version !== l.binding.recordVersion)
    return {
      decision: 'deny' as const,
      rule: 'record_changed',
      reason:
        'The record changed since the code was sent: look at it again, then ask for a new code',
    };
  return null;
}

/* ── acceptance.challenge ──────────────────────────────────────────────────── */

interface ChallengeLoaded {
  r: Resolved;
  signer: Signer | undefined;
  prior: boolean;
  target: { channel: OtpChannel; address: string } | undefined;
}

/**
 * acceptance.challenge: a code to accept one PDF, to the signer's own number or email. The code
 * is made and sent in the worker (otp.requested), never here (decisions B8, 9).
 */
export function challengeOp(
  otp: OtpService,
): WriteOp<z.output<typeof AcceptanceChallengeInput>, ChallengeLoaded, OtpRow> {
  return {
    name: 'acceptance.challenge',
    kind: 'command',
    system: true,
    resourceType: 'document',
    resourceId: (input) => input.documentId,
    input: AcceptanceChallengeInput,
    load: async (tx, p, input) => {
      const r = await resolveFor(tx, p, input.documentId);
      const signer = await signerOf(tx, p);
      const prior = signer ? await acceptedBefore(tx, tenantOf(p), r.doc.id, signer) : false;
      const options = addressesOf(r.def, signer);
      const target = input.channel ? options.find((o) => o.channel === input.channel) : options[0];
      return { r, signer, prior, target };
    },
    authorize: (p, l, input) => {
      const decision = decide(p, l.r, l);
      if (decision.decision !== 'allow') return decision;
      const channels = channelsOfAcceptance(l.r.def);
      if (!channels.length)
        return { decision: 'deny', rule: 'no_codes', reason: 'This is signed at a provider' };
      if (input.channel && !channels.includes(input.channel))
        return {
          decision: 'deny',
          rule: 'channel_unavailable',
          reason: `Codes for this don't go by ${input.channel}`,
        };
      if (!l.target) {
        const want = input.channel ?? channels[0];
        return want === 'email'
          ? { decision: 'deny', rule: 'no_email', reason: 'There is no email to send a code to' }
          : {
              decision: 'deny',
              rule: 'no_whatsapp_number',
              reason: 'No WhatsApp number is linked to you here',
            };
      }
      return decision;
    },
    summarize: (_input, l) => `Ask for a code to accept ${l.r.doc.fileName}`,
    run: async ({ tx, principal: p, input, loaded: l }) => {
      const signer = l.signer as Signer;
      const target = l.target as { channel: OtpChannel; address: string };
      const lang: Lang = input.lang ?? (l.r.doc.lang as Lang);
      const meta: ChallengeMeta = {
        statement: statementOf(l.r, lang),
        lang,
        business: businessName(l.r.doc),
        signerName: signer.name,
        customerId: signer.customerId,
        contactId: signer.whatsappContactId,
      };
      const row = await otp.create(tx, {
        tenantId: tenantOf(p),
        purpose: ACCEPTANCE_PURPOSE,
        subject: { userId: signer.userId, contactId: signer.contactId },
        channel: target.channel,
        address: target.address,
        ttlMs: (l.r.def.otp?.ttlMinutes ?? 10) * OTP_MINUTE,
        maxAttempts: l.r.def.otp?.attempts,
        resource: { type: l.r.entity.name, id: l.r.doc.resourceId },
        binding: bindingOf(l.r) as unknown as Values,
        meta: meta as unknown as Values,
      });
      return {
        value: row,
        touched: [
          {
            type: 'otpChallenge',
            id: row.id,
            change: 'created',
            after: {
              purpose: row.purpose,
              channel: row.channel,
              sentTo: maskAddress(row.address),
              documentId: l.r.doc.id,
              expiresAt: row.expiresAt.toISOString(),
            },
          },
        ],
        events: [new OtpRequested(row)],
      };
    },
    present: (row) => {
      const meta = row.meta as unknown as ChallengeMeta;
      return {
        id: row.id,
        documentId: (row.binding as unknown as Binding).documentId,
        channel: row.channel,
        sentTo: maskAddress(row.address),
        expiresAt: row.expiresAt.toISOString(),
        statement: meta.statement,
        lang: meta.lang,
      };
    },
  };
}

/* ── acceptance.accept ─────────────────────────────────────────────────────── */

const noCode = () =>
  new BadRequestException({
    error: 'no_code',
    message: 'This code is used or has expired: ask for a new one',
  });

/**
 * A guess at an acceptance's code, before any write (decisions B8, 11): the challenge is read and
 * the attempt spent on the pool, one statement each, with no transaction open. Inside the
 * accepting write's transaction the spend would need a second connection while the first waits
 * for it, so enough guesses at once would hold every connection and the API would stop
 * answering. Not the principal's own challenge (or a signing at a provider): 404. A wrong guess
 * is refused here (`wrong_code`), and its attempt stays spent. A used or expired code is refused
 * here too (`no_code`), unless the request may repeat one that accepted (`repeat`: it carries an
 * idempotency key), which the write then answers with what it answered first.
 */
export async function guessCode(
  otp: OtpService,
  p: Principal,
  input: Pick<z.output<typeof AcceptInput>, 'challengeId' | 'code'>,
  opts: { repeat?: boolean } = {},
): Promise<OtpOutcome> {
  const ch = await otp.get(input.challengeId);
  if (!theirs(ch, p, ACCEPTANCE_PURPOSE) || ch.channel === 'esign')
    throw new NotFoundException({ error: 'not_found', message: 'No such code' });
  const outcome = await otp.guess(ch, input.code);
  if (outcome === 'wrong')
    throw new BadRequestException({ error: 'wrong_code', message: "That code isn't right" });
  if (outcome === 'none' && !opts.repeat) throw noCode();
  return outcome;
}

interface AcceptLoaded {
  ch: OtpRow;
  binding: Binding;
  r: Resolved;
  signer: Signer | undefined;
  prior: boolean;
}

/**
 * acceptance.accept: the code received, for the PDF it was sent for. The guess was made before
 * the write (`guessCode`, `guessed`): only a right one accepts; anything else is `no_code` (a
 * repeat of an accepted request, by its idempotency key, is answered before this loads). The
 * challenge is read again in this transaction, and the code is used there, with the evidence,
 * the record's move and the application's own work.
 */
export function acceptOp(
  otp: OtpService,
  request: { client: ClientInfo; requestId: string; guessed: OtpOutcome },
): WriteOp<z.output<typeof AcceptInput>, AcceptLoaded, EvidenceRow> {
  return {
    name: 'acceptance.accept',
    kind: 'command',
    system: true,
    resourceType: 'document',
    resourceId: (_input, loaded) => loaded?.binding.documentId ?? null,
    input: AcceptInput,
    load: async (tx, p, input) => {
      if (request.guessed !== 'ok') throw noCode();
      const ch = await otp.get(input.challengeId, tx);
      if (!theirs(ch, p, ACCEPTANCE_PURPOSE) || ch.channel === 'esign')
        throw new NotFoundException({ error: 'not_found', message: 'No such code' });
      const binding = ch.binding as unknown as Binding;
      const r = await resolveFor(tx, p, binding.documentId, { lock: true });
      const signer = await signerOf(tx, p);
      const prior = signer ? await acceptedBefore(tx, tenantOf(p), r.doc.id, signer) : false;
      return { ch, binding, r, signer, prior };
    },
    authorize: (p, l) => stillBound(l) ?? decide(p, l.r, l),
    summarize: (_input, l) => `Accept ${l.r.doc.fileName}`,
    run: async ({ tx, principal: p, input, loaded: l }) => {
      if (!(await otp.consume(tx, l.ch.id))) throw noCode();
      const signer = l.signer as Signer;
      const meta = l.ch.meta as unknown as ChallengeMeta;
      const now = new Date();
      const evidence: EvidenceInput = {
        ...documentPart(l.r, l.binding),
        method: 'otp',
        statement: meta.statement,
        lang: meta.lang,
        signerKind: signer.kind,
        signerUserId: signer.userId,
        signerContactId: signer.contactId,
        signerCustomerId: signer.customerId,
        signerName: signer.name,
        challengeId: l.ch.id,
        otpChannel: l.ch.channel,
        otpAddress: l.ch.address,
        otpSentAt: l.ch.issuedAt,
        otpVerifiedAt: now,
        esignProvider: null,
        esignRef: null,
        esignCertificate: null,
        ip: request.client.ip,
        forwardedFor: request.client.forwardedFor,
        userAgent: request.client.userAgent,
        device: (input.device as AcceptanceDevice | undefined) ?? null,
        channel: p.channel ?? null,
        assurance: p.assurance ?? null,
        requestId: request.requestId,
        acceptedAt: now,
      };
      const row = await recordEvidence(tx, evidence);
      return follow(tx, p, l.r, row, 'acceptance.accept');
    },
    present: (row, p) => presentEvidence(row, p),
  };
}

/* ── acceptance.esign ──────────────────────────────────────────────────────── */

interface ESignLoaded {
  r: Resolved;
  signer: Signer | undefined;
  prior: boolean;
}

/**
 * acceptance.esign: a pending signing at the acceptance's provider (a challenge of channel
 * 'esign', with no code). The controller then asks the provider to start it.
 */
export function esignOp(
  otp: OtpService,
): WriteOp<z.output<typeof ESignStartInput>, ESignLoaded, OtpRow> {
  return {
    name: 'acceptance.esign',
    kind: 'command',
    system: true,
    resourceType: 'document',
    resourceId: (input) => input.documentId,
    input: ESignStartInput,
    load: async (tx, p, input) => {
      const r = await resolveFor(tx, p, input.documentId);
      const signer = await signerOf(tx, p);
      const prior = signer ? await acceptedBefore(tx, tenantOf(p), r.doc.id, signer) : false;
      return { r, signer, prior };
    },
    authorize: (p, l) => {
      const decision = decide(p, l.r, l);
      if (decision.decision !== 'allow') return decision;
      if (!l.r.def.esign)
        return { decision: 'deny', rule: 'no_esign', reason: 'This is not signed at a provider' };
      return decision;
    },
    summarize: (_input, l) => `Start signing ${l.r.doc.fileName}`,
    run: async ({ tx, principal: p, input, loaded: l }) => {
      const signer = l.signer as Signer;
      const lang: Lang = input.lang ?? (l.r.doc.lang as Lang);
      const meta: ChallengeMeta = {
        statement: statementOf(l.r, lang),
        lang,
        business: businessName(l.r.doc),
        signerName: signer.name,
        customerId: signer.customerId,
        contactId: signer.whatsappContactId,
      };
      const row = await otp.create(
        tx,
        {
          tenantId: tenantOf(p),
          purpose: ESIGN_PURPOSE,
          subject: { userId: signer.userId, contactId: signer.contactId },
          channel: 'esign',
          address: l.r.def.esign as string,
          ttlMs: ESIGN_TTL_MS,
          resource: { type: l.r.entity.name, id: l.r.doc.resourceId },
          binding: bindingOf(l.r) as unknown as Values,
          meta: meta as unknown as Values,
        },
        // Every signing at one provider has its name as the address: count per person only.
        { perAddress: false },
      );
      return {
        value: row,
        touched: [
          {
            type: 'otpChallenge',
            id: row.id,
            change: 'created',
            after: { purpose: row.purpose, provider: row.address, documentId: l.r.doc.id },
          },
        ],
      };
    },
    present: (row) => ({
      id: row.id,
      provider: row.address,
      ref: '',
      url: null,
      expiresAt: null,
    }),
  };
}

/* ── acceptance.signed (an e-sign provider's verified result) ──────────────── */

interface SignedLoaded {
  ch: OtpRow;
  binding: Binding;
  r: Resolved;
  prior: boolean;
}

/**
 * acceptance.signed: what an e-sign provider reported as signed, recorded as the business's
 * system principal (the signer was checked when the signing started), after the same binding
 * checks as a code.
 */
export function signedOp(
  otp: OtpService,
  ch: OtpRow,
  result: ESignResult,
): WriteOp<Record<string, never>, SignedLoaded, EvidenceRow> {
  return {
    name: 'acceptance.signed',
    kind: 'command',
    system: true,
    resourceType: 'document',
    resourceId: (_input, loaded) => loaded?.binding.documentId ?? null,
    input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    load: async (tx, p) => {
      const binding = ch.binding as unknown as Binding;
      const r = await resolveForSystem(tx, p, binding.documentId);
      const prior = await acceptedBefore(tx, ch.tenantId, r.doc.id, ch);
      return { ch, binding, r, prior };
    },
    authorize: (p, l) => {
      const moved = stillBound(l);
      if (moved) return moved;
      const refused = acceptable(l.r, p);
      if (refused) return refused;
      if (l.prior)
        return { decision: 'deny', rule: 'already_accepted', reason: 'Already accepted' };
      return {
        decision: 'allow',
        rule: 'provider_signed',
        reason: 'The provider reports it signed',
      };
    },
    summarize: (_input, l) => `Record the signing of ${l.r.doc.fileName}`,
    run: async ({ tx, principal: p, loaded: l }) => {
      if (!(await otp.consume(tx, l.ch.id)))
        throw new BadRequestException({ error: 'no_code', message: 'This signing has ended' });
      const meta = l.ch.meta as unknown as ChallengeMeta;
      const now = new Date();
      const evidence: EvidenceInput = {
        ...documentPart(l.r, l.binding),
        method: 'esign',
        statement: meta.statement,
        lang: meta.lang,
        signerKind: l.ch.userId ? 'user' : 'contact',
        signerUserId: l.ch.userId,
        signerContactId: l.ch.contactId,
        signerCustomerId: meta.customerId,
        signerName: result.signerName ?? meta.signerName,
        challengeId: l.ch.id,
        otpChannel: null,
        otpAddress: null,
        otpSentAt: null,
        otpVerifiedAt: null,
        esignProvider: result.provider,
        esignRef: result.ref,
        esignCertificate: {
          ...(result.certificate ?? {}),
          ...(result.signedSha256 ? { signedSha256: result.signedSha256 } : {}),
          ...(result.signedAt ? { signedAt: result.signedAt.toISOString() } : {}),
        },
        ip: null,
        forwardedFor: null,
        userAgent: null,
        device: null,
        channel: p.channel ?? null,
        assurance: null,
        requestId: null,
        acceptedAt: now,
      };
      const row = await recordEvidence(tx, evidence);
      return follow(tx, p, l.r, row, 'acceptance.signed');
    },
    present: (row, p) => presentEvidence(row, p),
  };
}
