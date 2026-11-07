// The acceptance feature in use (B8), on neutral data: an `agreements` module whose agreement is
// offered to its customer and accepted by a one-time code (moving it to `accepted`, frozen), a
// field only some roles see, a summary signed at a fixture e-sign provider by holders of a
// capability, and the server the acceptance e2e test boots (`acceptanceApp`).
import {
  type AcceptanceDef,
  defineAcceptance,
  defineDocument,
  defineESignProvider,
  defineModule,
  defineServer,
  type ESignStart,
} from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  defineCapability,
  defineRole,
  entitySpec,
  moduleSpec,
} from '@hykr/contracts';
import { defineEntity, entityController, entityHandlers, type ReadProjector } from '@hykr/core';
import { type Access, can } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { agreements } from './schema.js';

const same = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);
const STATUS = ['draft', 'offered', 'accepted', 'withdrawn'] as const;

export const Agreement = z.object({
  id: z.string(),
  title,
  terms: z.string(),
  /** Only with fixture.agreements.margin. */
  margin: z.string().nullable().optional(),
  status: z.enum(STATUS),
  version: z.number().int(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const AgreementSpec = entitySpec({
  name: 'agreement',
  label: 'agreement',
  description: 'Agreements: offered to a customer, who accepts one by a code.',
  schemas: {
    read: Agreement,
    create: z.object({
      title,
      terms: z.string().max(2000).default(''),
      margin: z.string().max(50).optional(),
    }),
    update: z.object({
      title: title.optional(),
      terms: z.string().max(2000).optional(),
      margin: z.string().max(50).nullable().optional(),
      status: z.enum(STATUS).optional(),
      version: z.number().int().optional(),
    }),
  },
  list: {
    filterable: { status: 'enum', title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
  },
  traits: {
    states: {
      field: 'status',
      initial: 'draft',
      states: {
        draft: { label: same('Draft') },
        offered: { label: same('Offered') },
        accepted: { label: same('Accepted') },
        withdrawn: { label: same('Withdrawn'), terminal: true },
      },
      transitions: [
        { name: 'offer', from: 'draft', to: 'offered', label: same('Offer') },
        // Only an acceptance moves it here (the acceptance feature requires expose: 'system').
        { name: 'accept', from: 'offered', to: 'accepted', expose: 'system' },
        { name: 'withdraw', from: ['draft', 'offered'], to: 'withdrawn', label: same('Withdraw') },
      ],
    },
    versioned: { frozenWhen: { status: ['offered', 'accepted', 'withdrawn'] } },
  },
});

/** Who signs summaries at the provider (no customer). */
export const SignerRole = defineRole({ name: 'fixture_signer', label: same('Signer') });

export const SignSummaries = defineCapability({
  name: 'fixture.agreements.sign',
  label: same('Sign agreement summaries'),
  roles: ['fixture_signer'],
});

/** Who sees an agreement's margin. */
export const MarginRead = defineCapability({
  name: 'fixture.agreements.margin',
  label: same('See margins'),
  roles: ['owner'],
});

/** The business reads every agreement; staff and signers too; a customer their own. */
const ACCESS: Access = {
  read: {
    owner: 'tenant',
    admin: 'tenant',
    ops: 'tenant',
    staff: 'tenant',
    fixture_signer: 'tenant',
    customer: 'customer',
  },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const AgreementDef = defineEntity(AgreementSpec, {
  table: agreements,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

/** The margin leaves only for whoever may see it. */
export const marginHidden: ReadProjector = {
  name: 'fixture.agreements.margin',
  project: (type, value, p) => {
    if (type !== 'agreement' || can(p, MarginRead)) return value;
    const { margin: _hidden, ...rest } = value;
    return rest;
  },
};

/** An acceptance's statement is for whoever may see margins (a projector on 'acceptance'). */
export const statementHidden: ReadProjector = {
  name: 'fixture.acceptance.statement',
  project: (type, value, p) => {
    if (type !== 'acceptance' || !String(value.statement ?? '').includes('[private]')) return value;
    return can(p, MarginRead) ? value : { ...value, statement: '[hidden]' };
  },
};

@Module({
  controllers: [entityController(AgreementDef)],
  providers: [...entityHandlers(AgreementDef)],
})
export class AgreementsModule {}

type AgreementData = { title: string; terms: string };

const agreementData = ({ record }: { record: Record<string, unknown> }): AgreementData => ({
  title: String(record.title),
  terms: String(record.terms ?? ''),
});

/** The agreement as a PDF: its title and terms, never its margin. */
export const AgreementDocument = defineDocument<AgreementData>({
  name: 'agreements.agreement',
  label: same('Agreement'),
  entity: 'agreement',
  capabilities: [],
  load: agreementData,
  render: (d) => ({
    title: `Agreement ${d.title}`,
    blocks: [
      { type: 'heading', text: d.title },
      { type: 'text', text: d.terms || 'No terms.' },
    ],
  }),
  fileName: (d) => `agreement-${d.title}`,
});

/** A one-page summary, signed at the fixture's provider. */
export const SummaryDocument = defineDocument<AgreementData>({
  name: 'agreements.summary',
  label: same('Summary'),
  entity: 'agreement',
  capabilities: [],
  load: agreementData,
  render: (d) => ({ title: `Summary ${d.title}`, blocks: [{ type: 'heading', text: d.title }] }),
  fileName: (d) => `summary-${d.title}`,
});

/** Accepted by the agreement's customer, by a code by email or WhatsApp: it is then accepted. */
export const AgreementAcceptance: AcceptanceDef<AgreementData> = defineAcceptance<AgreementData>({
  name: 'agreements.agreement',
  document: 'agreements.agreement',
  label: same('Accept the agreement'),
  statement: (d) => `I accept the agreement ${d.title} as shown in this PDF.`,
  by: 'customer',
  channels: ['email', 'whatsapp'],
  transition: 'accept',
});

/** Signed by holders of fixture.agreements.sign, at the provider only; the record stays. */
export const SummarySigning = defineAcceptance<AgreementData>({
  name: 'agreements.summary',
  document: 'agreements.summary',
  label: same('Sign the summary'),
  statement: (d) => `I sign the summary of ${d.title}.`,
  by: { capability: SignSummaries.name },
  channels: [],
  esign: 'fixture-esign',
});

/** What the fixture's provider was asked to start, for the test to look at. */
export const esignStarts: { request: ESignStart; bytes: number }[] = [];

/** A stand-in e-sign provider: a reference and a link per signing, nothing else. */
export const FixtureESign = defineESignProvider({
  name: 'fixture-esign',
  start: async (request) => {
    esignStarts.push({ request, bytes: (await request.document.bytes()).length });
    return {
      ref: `ref-${request.requestId}`,
      url: `https://esign.invalid/${request.requestId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    };
  },
});

export const agreementsModule = defineModule({
  ...moduleSpec({
    name: 'agreements',
    dependsOn: [],
    entities: { agreements: AgreementSpec },
    commands: [],
  }),
  server: AgreementsModule,
  tables: { agreements },
});

export const acceptanceContributions: Partial<Contributions> = {
  roles: [SignerRole],
  capabilities: [SignSummaries, MarginRead],
  readProjectors: [marginHidden, statementHidden],
  documents: [AgreementDocument, SummaryDocument],
  acceptances: [AgreementAcceptance, SummarySigning],
  esignProviders: [FixtureESign],
};

/** The fixture plus agreements, their documents and acceptances. */
export const acceptanceApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, agreementsModule],
  contributes: acceptanceContributions,
});
