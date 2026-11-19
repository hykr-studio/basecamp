// The settings sections a business changes itself (H2), in use: a `claims` module whose claims
// reach an approval level by the business's threshold (`approvals.thresholds['claims.limit']`),
// wait for the approver its bands name (`approvals.bands.claims`), and carry two SLAs on their
// open state, one counted in the business's hours. A change to who approves waits for a second
// person (a level rule on `settings.section`). The module also has a settings section of its
// own, changed with its own capability and checked by its own settings check. Only the
// settings-sections test's server (`settingsSectionsApp`) loads this file.
import { defineModule, defineServer, defineSettingsCheck } from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  defineApprovalLevel,
  defineCapability,
  defineSettingsSection,
  entitySpec,
  type Money,
  moduleSpec,
  overThreshold,
} from '@hykr/contracts';
import {
  atLevel,
  defineEntity,
  defineLevelRule,
  entityController,
  entityHandlers,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { claims } from './schema.js';

declare module '@hykr/contracts' {
  interface TenantSettingsSections {
    fixtureClaims: FixtureClaimsSettings;
  }
}

const label = (en: string) => ({ en, hi: en, te: en });
const title = z.string().min(1).max(200);
const STATUS = ['open', 'done'] as const;

/** Runs, whoever asks. */
export const RoutineLevel = defineApprovalLevel({
  name: 'fixture_claims_routine',
  rank: 1,
  label: label('Routine'),
  policy: { parks: false },
});

/** Always waits, for the approver the business's bands name for the amount. */
export const LargeLevel = defineApprovalLevel({
  name: 'fixture_claims_large',
  rank: 3,
  label: label('Large'),
  policy: { approver: { by: { band: 'claims' } } },
});

/** The module's own settings section is changed by holders of this (owners). */
export const ClaimsSetup = defineCapability({
  name: 'fixture.claims.setup',
  label: label('Set up claims'),
  roles: ['owner'],
});

/** A band may name it: admins decide claims. */
export const ClaimsApprove = defineCapability({
  name: 'fixture.claims.approve',
  label: label('Approve claims'),
  roles: ['admin'],
});

export const Claim = z.object({
  id: z.string(),
  title,
  amountMinor: z.number().int(),
  currency: z.string(),
  status: z.enum(STATUS),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const ClaimSpec = entitySpec({
  name: 'claim',
  label: 'claim',
  description: 'Claims: a title and an amount in minor units, open until done.',
  schemas: {
    read: Claim,
    create: z.object({
      title,
      amountMinor: z.number().int().min(0),
      currency: z.string().regex(/^[A-Z]{3}$/),
      status: z.string().optional(),
    }),
    update: z.object({ title: title.optional(), status: z.enum(STATUS).optional() }),
  },
  list: {
    filterable: { status: 'enum' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  traits: {
    states: {
      field: 'status',
      initial: 'open',
      states: { open: { label: label('Open') }, done: { label: label('Done'), terminal: true } },
      transitions: [{ name: 'finish', from: 'open', to: 'done', label: label('Finish') }],
      slas: [
        { name: 'fixture.claims.answer', state: 'open', within: '1h' },
        { name: 'fixture.claims.review', state: 'open', within: '2h', hours: 'business' },
      ],
    },
  },
});

const ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own' },
};

export const ClaimDef = defineEntity(ClaimSpec, {
  table: claims,
  owner: (t) => t.ownerId,
  access: ACCESS,
});

/** A new claim above the business's `claims.limit` (or with none set) is large; else routine. */
export const ClaimLevels = defineLevelRule({
  name: 'fixture.claims',
  on: ['claim.create'],
  decide: ({ input, settings }) => {
    const amount: Money = {
      minor: Number(input?.amountMinor ?? 0),
      currency: String(input?.currency ?? ''),
    };
    return overThreshold(settings, 'claims.limit', amount)
      ? atLevel(LargeLevel.name, 'claim_over_limit', 'Above the business limit', { amount })
      : atLevel(RoutineLevel.name, 'claim_within_limit', 'Within the business limit', { amount });
  },
});

/**
 * Changing who approves (the business's approval bands) waits for a second person: the
 * application's choice, made with a level rule on the generic settings writer.
 */
export const ApproverChanges = defineLevelRule({
  name: 'fixture.claims.approvers',
  on: ['settings.section'],
  decide: ({ input }) => {
    const value = input?.value as Record<string, unknown> | undefined;
    return input?.section === 'approvals' && value && 'bands' in value
      ? atLevel(LargeLevel.name, 'approvers_change', 'Changing who approves needs a second person')
      : null;
  },
});

/** The module's own section: how many claims may be open at once, and a heading for them. */
export const FixtureClaimsSettings = z
  .object({
    maxOpen: z.number().int().min(1).max(1000).default(10),
    heading: z.string().min(1).max(40).optional(),
  })
  .default({ maxOpen: 10 });
export type FixtureClaimsSettings = z.infer<typeof FixtureClaimsSettings>;

export const FixtureClaimsSection = defineSettingsSection('fixtureClaims', FixtureClaimsSettings, {
  editable: { capability: ClaimsSetup.name },
});

/** Its own check, reading the business's claims in the write's transaction. */
export const MaxOpenCheck = defineSettingsCheck({
  name: 'fixture.claims.max-open',
  section: 'fixtureClaims',
  check: async (value, { tx, tenantId }) => {
    const [row] = await tx
      .select({ n: count() })
      .from(claims)
      .where(and(eq(claims.tenantId, tenantId), eq(claims.status, 'open')));
    const open = Number(row?.n ?? 0);
    return value.maxOpen < open ? [`fixtureClaims.maxOpen: ${open} claims are open already`] : [];
  },
});

@Module({ controllers: [entityController(ClaimDef)], providers: [...entityHandlers(ClaimDef)] })
class ClaimsModule {}

export const claimsModule = defineModule({
  ...moduleSpec({ name: 'claims', entities: { claims: ClaimSpec }, commands: [] }),
  server: ClaimsModule,
  tables: { claims },
});

export const claimsContributions: Partial<Contributions> = {
  approvalLevels: [RoutineLevel, LargeLevel],
  capabilities: [ClaimsSetup, ClaimsApprove],
  levelRules: [ClaimLevels, ApproverChanges],
  settingsChecks: [MaxOpenCheck],
};

/** The fixture with the claims module, its levels, level rule, capabilities and check. */
export const settingsSectionsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, claimsModule],
  contributes: claimsContributions,
});
