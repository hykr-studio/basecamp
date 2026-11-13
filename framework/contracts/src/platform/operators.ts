// The platform's operators (B19): the people who run a deployment, above its businesses. What
// they may do is a capability of their own (`platform.*`), never a role in a business. Served by
// @hykr/api's `platform` feature (/api/platform/*, and a business's /api/support-access/*).
import type { Labels } from '@hykr/i18n';
import { z } from 'zod';
import { createHookRegistry } from '../framework/registry.js';
import { ROLE_NAME } from '../principal.js';
import { CAPABILITY_NAME, defineCapability } from '../roles.js';

declare module '../framework/module.js' {
  interface Contributions {
    operatorCapabilities: readonly OperatorCapabilityDef[];
  }
}

/** Something an operator may do above the businesses: 'platform.tenants'. */
export interface OperatorCapabilityDef {
  /** Dotted, namespaced by its owner: 'platform.usage'. */
  name: string;
  label: Labels;
}

/** An operator capability, checked: a dotted name. */
export function defineOperatorCapability(def: OperatorCapabilityDef): OperatorCapabilityDef {
  if (!CAPABILITY_NAME.test(def.name))
    throw new Error(`Operator capability "${def.name}": name it <area>.<action>, lower case`);
  return def;
}

/** Every operator capability. Collects `contributes.operatorCapabilities`. */
export const operatorCapabilities = createHookRegistry<OperatorCapabilityDef>(
  'operator capability',
  (c) => defineOperatorCapability(c).name,
  { collects: 'operatorCapabilities' },
);

/** The framework's operator capabilities. */
export const PlatformCapabilities = {
  /** Add, change and disable operators. */
  operators: defineOperatorCapability({
    name: 'platform.operators',
    label: { en: 'Manage operators', hi: 'ऑपरेटर संभालें', te: 'ఆపరేటర్లను నిర్వహించండి' },
  }),
  /** List businesses, make one for a person, rename one, switch its platform-managed flags. */
  tenants: defineOperatorCapability({
    name: 'platform.tenants',
    label: {
      en: 'Manage businesses',
      hi: 'व्यवसाय संभालें',
      te: 'వ్యాపారాలను నిర్వహించండి',
    },
  }),
  /** Ask a business for support access, and use it once it consents. */
  support: defineOperatorCapability({
    name: 'platform.support',
    label: {
      en: 'Ask for support access',
      hi: 'सहायता पहुँच माँगें',
      te: 'సహాయ ప్రాప్తిని అడగండి',
    },
  }),
  /** What every business used, across the deployment. */
  usage: defineOperatorCapability({
    name: 'platform.usage',
    label: {
      en: 'See usage across businesses',
      hi: 'सभी व्यवसायों का उपयोग देखें',
      te: 'అన్ని వ్యాపారాల వినియోగాన్ని చూడండి',
    },
  }),
  /** A business's credits: its plan, an override, grants (the credits feature's operator routes). */
  credits: defineOperatorCapability({
    name: 'platform.credits',
    label: {
      en: "Manage a business's credits",
      hi: 'व्यवसाय के क्रेडिट संभालें',
      te: 'వ్యాపార క్రెడిట్‌లను నిర్వహించండి',
    },
  }),
  /** The job queues' dashboard (Bull Board): every business's jobs. */
  queues: defineOperatorCapability({
    name: 'platform.queues',
    label: { en: 'Open the job queues', hi: 'जॉब कतारें खोलें', te: 'జాబ్ క్యూలను తెరవండి' },
  }),
  /** Publish the platform's shared records (rows of the platform's business). */
  shared: defineOperatorCapability({
    name: 'platform.shared',
    label: {
      en: 'Publish shared records',
      hi: 'साझा रिकॉर्ड प्रकाशित करें',
      te: 'భాగస్వామ్య రికార్డులను ప్రచురించండి',
    },
  }),
  /** What happened to inbound requests the platform routed to businesses. */
  routing: defineOperatorCapability({
    name: 'platform.routing',
    label: {
      en: 'See routed requests',
      hi: 'भेजे गए अनुरोध देखें',
      te: 'పంపిన అభ్యర్థనలను చూడండి',
    },
  }),
} as const;

operatorCapabilities.register(...Object.values(PlatformCapabilities));

/**
 * The business capability an operator holds at platform scope (working in the platform's own
 * business, PLATFORM_TENANT_ID): a shared entity whose access names it lets operators maintain
 * the rows every business reads. No role has it, and no business may give it to one.
 */
export const SharedPublishCapability = defineCapability({
  name: 'shared.publish',
  label: {
    en: 'Publish shared records (platform operators)',
    hi: 'साझा रिकॉर्ड प्रकाशित करें (प्लैटफ़ॉर्म ऑपरेटर)',
    te: 'భాగస్వామ్య రికార్డులను ప్రచురించండి (ప్లాట్‌ఫామ్ ఆపరేటర్లు)',
  },
  grantable: false,
});

const OperatorCapabilityName = z.string().regex(CAPABILITY_NAME);
const RoleName = z.string().regex(ROLE_NAME);
const Email = z.email().max(320);

/* ── Operators ──────────────────────────────────────────────────────────── */

/** An operator, as other operators see them. */
export type Operator = {
  id: string;
  userId: string;
  name: string;
  email: string;
  capabilities: string[];
  note: string | null;
  createdAt: string;
  disabledAt: string | null;
};

/** What `GET /api/platform/me` answers: null for anyone who is no (enabled) operator. */
export type PlatformMe = { operator: { id: string; capabilities: string[] } | null };

export const AddOperatorInput = z
  .object({
    email: Email,
    capabilities: z.array(OperatorCapabilityName).min(1).max(40),
    note: z.string().max(500).optional(),
  })
  .strict();
export type AddOperatorInput = z.infer<typeof AddOperatorInput>;

export const UpdateOperatorInput = z
  .object({
    capabilities: z.array(OperatorCapabilityName).min(1).max(40).optional(),
    note: z.string().max(500).nullable().optional(),
    /** false: disabled at once (their support access with it); true: enabled again. */
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateOperatorInput = z.infer<typeof UpdateOperatorInput>;

/* ── Businesses ─────────────────────────────────────────────────────────── */

/** A business, as operators list them. */
export type PlatformTenant = {
  id: string;
  name: string;
  defaultOwnerId: string;
  members: number;
  createdAt: string;
};

/** Make a business for a person who has an account: they become its owner. */
export const ProvisionTenantInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    owner: z.object({ email: Email }).strict(),
  })
  .strict();
export type ProvisionTenantInput = z.infer<typeof ProvisionTenantInput>;

export const RenameTenantInput = z.object({ name: z.string().trim().min(1).max(120) }).strict();
export type RenameTenantInput = z.infer<typeof RenameTenantInput>;

export const SetPlatformFeatureInput = z.object({ on: z.boolean() }).strict();
export type SetPlatformFeatureInput = z.infer<typeof SetPlatformFeatureInput>;

/* ── Support access ─────────────────────────────────────────────────────── */

/** `read`: GET and HEAD only. `write`: writes like a member with the roles consented. */
export const SupportAccessMode = z.enum(['read', 'write']);
export type SupportAccessMode = z.infer<typeof SupportAccessMode>;

/** Where a grant stands now: worked out from its times, never stored. */
export const SupportGrantStatus = z.enum([
  'requested',
  'active',
  'declined',
  'expired',
  'ended',
  'revoked',
]);
export type SupportGrantStatus = z.infer<typeof SupportGrantStatus>;

/** An operator asks one business for access: for what, with which roles and capabilities, how long. */
export const SupportRequestInput = z
  .object({
    tenantId: z.uuid(),
    reason: z.string().trim().min(3).max(500),
    /** Which rows: the business's roles whose access applies. */
    roles: z.array(RoleName).min(1).max(10),
    /** Which features (`backoffice.use`, a field's capability): only these, not the roles'. */
    capabilities: z.array(z.string().regex(CAPABILITY_NAME)).max(40).default([]),
    access: SupportAccessMode.default('read'),
    minutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60),
  })
  .strict();
export type SupportRequestInput = z.infer<typeof SupportRequestInput>;

/** The business consents: as asked, or shorter, or read-only. */
export const SupportConsentInput = z
  .object({
    minutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .optional(),
    access: SupportAccessMode.optional(),
  })
  .strict();
export type SupportConsentInput = z.infer<typeof SupportConsentInput>;

/** A grant, as the business and the operator see it. */
export type SupportGrant = {
  id: string;
  tenantId: string;
  operator: { id: string; name: string; email: string };
  reason: string;
  roles: string[];
  capabilities: string[];
  access: SupportAccessMode;
  minutes: number;
  status: SupportGrantStatus;
  requestedAt: string;
  requestExpiresAt: string;
  consentedBy: string | null;
  consentedAt: string | null;
  endsAt: string | null;
  decidedAt: string | null;
  endedAt: string | null;
  endedBy: string | null;
};

/** One request made under support access. */
export type SupportActivity = {
  id: string;
  method: string;
  path: string;
  status: number;
  actorKind: string;
  at: string;
};

/* ── Usage and routing ──────────────────────────────────────────────────── */

/** One meter's use in a business over the report's range, as recorded (A3's usage events). */
export type UsageLine = { meter: string; quantity: number; cost: number };

/** A business's wallet over the range: its balance now and what came in and went out. */
export type UsageWallet = {
  currency: string;
  balance: number;
  topups: number;
  grants: number;
  debits: number;
};

export type UsageReport = {
  from: string;
  to: string;
  tenants: {
    tenantId: string;
    name: string;
    meters: UsageLine[];
    wallet: UsageWallet | null;
  }[];
  /** Across the businesses of this page. */
  totals: UsageLine[];
  /** The last business's id when there are more: pass it as `after`. */
  next: string | null;
};

/** What happened to one inbound request the platform was asked to route. */
export type RoutedRequest = {
  id: string;
  source: string;
  ref: string;
  router: string | null;
  tenantId: string | null;
  status: 'routed' | 'unrouted' | 'failed';
  reason: string | null;
  resourceType: string | null;
  resourceId: string | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  /**
   * In the routing log: pass the last row's as `before` for the rows after it. It keeps the row's
   * time as stored and its id, so rows that share a time are neither repeated nor skipped (V12).
   */
  cursor?: string;
};
