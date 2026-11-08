// Approval levels: what is at stake in an action, as the application declares it. The framework
// knows no level of its own. It orders them by rank (the highest wins where decisions meet),
// applies each level's policy (does it wait, who decides, where, how surely, for how long, and
// how long it can be undone) and lets a business adjust it in its settings (`approvals`).
import type { Labels } from '@hykr/i18n';
import type { Approver } from './authorize.js';
import { reserveRoutes } from './catalog.js';
import { createHookRegistry } from './framework/registry.js';
import type { Principal } from './principal.js';
import { capabilities, defineCapability } from './roles.js';

declare module './framework/module.js' {
  interface Contributions {
    approvalLevels: readonly ApprovalLevelDef[];
  }
}

// POST /api/undo/:id: undoing a write within its undo window (@hykr/core).
reserveRoutes('undo');

/** A level's name: lower case letters, digits and _, starting with a letter ('internal'). */
export const LEVEL_NAME = /^[a-z][a-z0-9_]*$/;

/** What happens to an action at this level. Every part has a neutral default. */
export interface ApprovalLevelPolicy {
  /**
   * Does an action at this level wait for a decision: always, never, or for some requesters.
   * Default: a level of rank 0 runs, any higher level parks.
   */
  parks?: boolean | ((p: Principal) => boolean);
  /**
   * An action at this level that runs can be undone for this long (milliseconds), and its events
   * wait as long. Default: no undo window.
   */
  undoMs?: number;
  /**
   * Who decides, where and how surely, when it parks. Default: the requester (a customer's
   * request: holders of `approvals.decide`).
   */
  approver?: Approver;
  /** How long it waits for a decision (milliseconds). Default: the deployment's approval TTL. */
  expiresInMs?: number;
  /** May a business switch parking off for this level in its settings? Default: no. */
  tenantMayLoosen?: boolean;
}

/** One level of what an action puts at stake, with its policy. */
export interface ApprovalLevelDef {
  /** As decisions name it: 'internal'. */
  name: string;
  /** Its order: higher means more at stake. Whole numbers, 0 to 99, unique. */
  rank: number;
  /** What people call it, on the approval card. */
  label: Labels;
  policy?: ApprovalLevelPolicy;
}

const MIN_EXPIRY_MS = 60_000;

/** A level, checked: its name, a whole rank from 0 to 99, a sane undo window and expiry. */
export function defineApprovalLevel(def: ApprovalLevelDef): ApprovalLevelDef {
  const problem = (why: string) => new Error(`Approval level "${def.name}": ${why}`);
  if (!LEVEL_NAME.test(def.name)) throw problem('use lower case letters, digits and _');
  if (!Number.isInteger(def.rank) || def.rank < 0 || def.rank > 99)
    throw problem('its rank is a whole number from 0 to 99');
  const policy = def.policy ?? {};
  if (policy.undoMs !== undefined && !(Number.isInteger(policy.undoMs) && policy.undoMs >= 0))
    throw problem('undoMs is whole milliseconds, 0 or more');
  if (
    policy.expiresInMs !== undefined &&
    !(Number.isInteger(policy.expiresInMs) && policy.expiresInMs >= MIN_EXPIRY_MS)
  )
    throw problem('expiresInMs is whole milliseconds, at least a minute');
  return def;
}

/** Every level the application declares. Collects `contributes.approvalLevels`. */
export const approvalLevels = createHookRegistry<ApprovalLevelDef>(
  'approval level',
  (l) => defineApprovalLevel(l).name,
  { collects: 'approvalLevels' },
);

/** A level by name, or undefined when nobody declared it. */
export const levelOf = (name: string | undefined): ApprovalLevelDef | undefined =>
  name === undefined ? undefined : approvalLevels.get(name);

/**
 * A level's rank, for comparing decisions. A level nobody declared ranks above every declared
 * one (fail closed: it wins, and then parks); no level is below every level.
 */
export function rankOf(name: string | undefined): number {
  if (name === undefined) return -1;
  return approvalLevels.get(name)?.rank ?? Number.POSITIVE_INFINITY;
}

/**
 * Fails when two levels share a rank ("the highest wins" would be ambiguous), or when a level's
 * approver names a capability nobody defines (nobody could ever decide it). Run when the API or
 * the worker starts.
 */
export function checkApprovalLevels(): void {
  const byRank = new Map<number, string>();
  for (const level of approvalLevels.all()) {
    const taken = byRank.get(level.rank);
    if (taken)
      throw new Error(`Approval levels "${taken}" and "${level.name}" share rank ${level.rank}`);
    byRank.set(level.rank, level.name);
    const by = level.policy?.approver?.by;
    if (by && typeof by === 'object' && 'capability' in by && !capabilities.has(by.capability))
      throw new Error(
        `Approval level "${level.name}" is decided by "${by.capability}", which nobody defines`,
      );
  }
}

/** The framework's capabilities for deciding, with the roles that decided before. */
export const ApprovalCapabilities = {
  /**
   * Decide the business's requests: a customer's, and any request whose level or rule names no
   * other decider. Never the requester's own.
   */
  decide: defineCapability({
    name: 'approvals.decide',
    label: {
      en: "Decide the business's requests",
      hi: 'व्यवसाय के अनुरोध तय करें',
      te: 'వ్యాపార అభ్యర్థనలను నిర్ణయించండి',
    },
    roles: ['owner', 'ops'],
    // Support access never decides (B19).
    supportable: false,
  }),
  /** Approve a marketing message sent to a customer by hand (notify.send). */
  marketing: defineCapability({
    name: 'marketing.approve',
    label: {
      en: 'Approve marketing messages',
      hi: 'मार्केटिंग संदेश मंज़ूर करें',
      te: 'మార్కెటింగ్ సందేశాలను అనుమతించండి',
    },
    roles: ['owner', 'admin'],
    // Support access never decides (B19).
    supportable: false,
  }),
} as const;

capabilities.register(...Object.values(ApprovalCapabilities));
