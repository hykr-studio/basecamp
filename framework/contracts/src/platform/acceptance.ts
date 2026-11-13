import { z } from 'zod';
import { commandSpec } from '../framework/spec.js';
import { LabelsShape, Lang, LangCode } from '../languages.js';

/**
 * Accepting a record's document (a PDF) with a one-time code, and the evidence each acceptance
 * leaves (docs/decisions/B8.md). An application declares what can be accepted, by whom, and what
 * follows (`defineAcceptance` in @hykr/api); the framework sends the code, checks it, binds the
 * acceptance to the PDF's hash and the record's version, and keeps the evidence append-only.
 */

/** Where a one-time code goes: the signer's WhatsApp number or their email. */
export const OtpChannel = z.enum(['whatsapp', 'email']);
export type OtpChannel = z.infer<typeof OtpChannel>;

/** How it was accepted: a one-time code, or a signing at an e-sign provider. */
export const AcceptanceMethod = z.enum(['otp', 'esign']);
export type AcceptanceMethod = z.infer<typeof AcceptanceMethod>;

const label = LabelsShape;

/** One kind of acceptance an entity has, as `GET /api/acceptances/kinds?entity=` lists it. */
export const AcceptanceKindInfo = z.object({
  name: z.string(),
  /** The document kind whose PDF is accepted. */
  document: z.string(),
  entity: z.string(),
  label,
  channels: z.array(OtpChannel),
  /** The e-sign provider it can also be signed at, when it has one. */
  esign: z.string().nullable(),
});
export type AcceptanceKindInfo = z.infer<typeof AcceptanceKindInfo>;

/** What the client says about the device it runs on (as reported, unverified). */
export const AcceptanceDevice = z
  .object({
    platform: z.string().max(40).optional(),
    appVersion: z.string().max(40).optional(),
    model: z.string().max(80).optional(),
  })
  .strict();
export type AcceptanceDevice = z.infer<typeof AcceptanceDevice>;

/**
 * One acceptance, as `/api/acceptances` shows it. `otp.address`, `client` and
 * `esign.certificate` are there only for holders of `acceptances.evidence`; others see
 * `otp.sentTo`, masked.
 */
export const AcceptanceInfo = z.object({
  id: z.string(),
  /** The application's acceptance: 'orders.order'. */
  acceptance: z.string(),
  method: AcceptanceMethod,
  record: z.object({ entity: z.string(), id: z.string(), version: z.number().int().nullable() }),
  document: z.object({
    id: z.string(),
    name: z.string(),
    version: z.number().int(),
    sha256: z.string(),
    fileName: z.string(),
  }),
  /** The words agreed to, in the language they were shown in. */
  statement: z.string(),
  lang: LangCode,
  signer: z.object({
    kind: z.enum(['user', 'contact']),
    userId: z.string().nullable(),
    contactId: z.string().nullable(),
    customerId: z.string().nullable(),
    name: z.string().nullable(),
  }),
  otp: z
    .object({
      channel: OtpChannel,
      /** Where the code went, masked: '•••• 4321', 'a•••@example.com'. */
      sentTo: z.string(),
      /** In full: evidence holders only. */
      address: z.string().optional(),
      sentAt: z.iso.datetime().nullable(),
      verifiedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  esign: z
    .object({
      provider: z.string(),
      ref: z.string(),
      certificate: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .nullable(),
  /** The request it came with: evidence holders only. */
  client: z
    .object({
      ip: z.string().nullable(),
      forwardedFor: z.string().nullable(),
      userAgent: z.string().nullable(),
      device: z.record(z.string(), z.string()).nullable(),
    })
    .optional(),
  channel: z.string().nullable(),
  acceptedAt: z.iso.datetime(),
  /** Its place in the business's chain, and its hash. */
  seq: z.number().int(),
  hash: z.string(),
  prevHash: z.string().nullable(),
  /** One acceptance's read: whether it still matches its hash and the row before it. */
  verified: z.boolean().optional(),
});
export type AcceptanceInfo = z.infer<typeof AcceptanceInfo>;

/** Whether the caller may accept: yes, or the rule and reason that refuses it. */
export const AcceptanceCan = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), rule: z.string(), reason: z.string() }),
]);
export type AcceptanceCan = z.infer<typeof AcceptanceCan>;

/** One document's acceptance, for the person looking at it (`GET /api/acceptances/documents/:id`). */
export const AcceptanceStatus = z.object({
  acceptance: z.string(),
  label,
  document: z.object({
    id: z.string(),
    name: z.string(),
    version: z.number().int(),
    sha256: z.string().nullable(),
    status: z.string(),
  }),
  /** What they would agree to, in the language asked for. */
  statement: z.string(),
  lang: LangCode,
  /** Where a code would go, per channel the signer has, masked. */
  channels: z.array(z.object({ channel: OtpChannel, sentTo: z.string() })),
  esign: z.string().nullable(),
  can: AcceptanceCan,
  /** The record's acceptances the caller may see, newest first. */
  accepted: z.array(AcceptanceInfo),
});
export type AcceptanceStatus = z.infer<typeof AcceptanceStatus>;

export const AcceptanceChallengeInput = z.object({
  documentId: z.uuid().describe('The PDF to accept (a document of the record)'),
  channel: OtpChannel.optional().describe(
    "Where the code goes. Default: the acceptance's first channel the signer has",
  ),
  lang: Lang.optional().describe('The language of the code message and the statement'),
});
export type AcceptanceChallengeInput = z.input<typeof AcceptanceChallengeInput>;

/** A code on its way: where it went (masked), until when it works, and what it accepts. */
export const AcceptanceChallenge = z.object({
  id: z.string(),
  documentId: z.string(),
  channel: OtpChannel,
  sentTo: z.string(),
  expiresAt: z.iso.datetime(),
  statement: z.string(),
  lang: LangCode,
});
export type AcceptanceChallenge = z.infer<typeof AcceptanceChallenge>;

/** Ask for a code to accept a document. People only. */
export const AcceptanceChallengeSpec = commandSpec({
  name: 'acceptance.challenge',
  description:
    "Send a one-time code to the signer's own WhatsApp number or email, to accept one PDF of a record.",
  input: AcceptanceChallengeInput,
  output: AcceptanceChallenge,
  http: { method: 'POST', path: '/api/acceptances/challenges' },
  expose: 'human',
  verb: { do: 'ask for a code', did: 'asked for a code' },
  touches: [],
});

export const AcceptInput = z.object({
  challengeId: z.uuid().describe('The code request (from acceptance.challenge)'),
  code: z.string().regex(/^\d{6}$/, 'The 6-digit code'),
  device: AcceptanceDevice.optional(),
});
export type AcceptInput = z.input<typeof AcceptInput>;

/** Accept the document with the code received. People only. */
export const AcceptSpec = commandSpec({
  name: 'acceptance.accept',
  description: 'Accept a PDF of a record with the one-time code that was sent for it.',
  input: AcceptInput,
  output: AcceptanceInfo,
  http: { method: 'POST', path: '/api/acceptances' },
  expose: 'human',
  verb: { do: 'accept', did: 'accepted' },
  touches: [],
});

export const ESignStartInput = z.object({
  documentId: z.uuid().describe('The PDF to sign'),
  lang: Lang.optional(),
});
export type ESignStartInput = z.input<typeof ESignStartInput>;

/** A signing started at a provider: where the signer goes. */
export const ESignStarted = z.object({
  id: z.string(),
  provider: z.string(),
  ref: z.string(),
  url: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});
export type ESignStarted = z.infer<typeof ESignStarted>;

/** Sign a document at the acceptance's e-sign provider. People only. */
export const ESignStartSpec = commandSpec({
  name: 'acceptance.esign',
  description: "Start signing a record's PDF at the acceptance's e-sign provider.",
  input: ESignStartInput,
  output: ESignStarted,
  http: { method: 'POST', path: '/api/acceptances/esign' },
  expose: 'human',
  verb: { do: 'start signing', did: 'started signing' },
  touches: [],
});

/** An address shown without giving it away: '•••• 4321', 'a•••@example.com'. */
export function maskAddress(address: string): string {
  const at = address.indexOf('@');
  if (at > 0) return `${address[0]}•••${address.slice(at)}`;
  const digits = address.replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '••••';
}
