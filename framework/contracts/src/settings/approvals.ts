// A business's own approval settings: what it changes in the application's levels, the amounts
// the application's rules compare with, and who decides each amount band. Everything defaults
// to empty, so a new business follows the application's policy as declared.
import { z } from 'zod';
import { CurrencyCode, Money } from '../framework/money.js';
import { defineSettingsSection, type TenantConfig } from './sections.js';

/** What a business changes in one level's policy. */
export const LevelOverride = z.object({
  /**
   * true: always wait. false: never wait, only where the level allows a business to loosen it
   * (`tenantMayLoosen`); elsewhere it is ignored.
   */
  parks: z.boolean().optional(),
  /** The undo window, in milliseconds. */
  undoMs: z.number().int().min(0).max(86_400_000).optional(),
  /** How long a request waits for a decision, in milliseconds (a minute to 30 days). */
  expiresInMs: z.number().int().min(60_000).max(2_592_000_000).optional(),
});
export type LevelOverride = z.infer<typeof LevelOverride>;

/** Who decides one amount band: a named person, or anyone holding a capability. */
export const BandApprover = z.union([
  z.object({ userId: z.string().min(1) }).strict(),
  z.object({ capability: z.string().min(1) }).strict(),
]);
export type BandApprover = z.infer<typeof BandApprover>;

/** One band: amounts up to `upTo` (inclusive; omitted: any amount) go to `approver`. */
export const ApprovalBand = z.object({ upTo: Money.optional(), approver: BandApprover });
export type ApprovalBand = z.infer<typeof ApprovalBand>;

export const ApprovalSettings = z
  .object({
    /** Per level name. */
    levels: z.record(z.string(), LevelOverride).default({}),
    /** Amounts the application's rules compare with, by key ('payments.limit'). */
    thresholds: z.record(z.string(), Money).default({}),
    /** Who decides which amount, by key, first matching band first. */
    bands: z.record(z.string(), z.array(ApprovalBand)).default({}),
  })
  .default({ levels: {}, thresholds: {}, bands: {} });
export type ApprovalSettings = z.infer<typeof ApprovalSettings>;

declare module './sections.js' {
  interface TenantSettingsSections {
    approvals: ApprovalSettings;
  }
}

export const ApprovalSettingsSection = defineSettingsSection('approvals', ApprovalSettings, {
  editable: true,
});

type WithApprovals = Pick<TenantConfig, 'approvals'> | { approvals?: ApprovalSettings };

/** The business's threshold for this key, or undefined when it set none. */
export function approvalThreshold(settings: WithApprovals, key: string): Money | undefined {
  return settings.approvals?.thresholds[key];
}

/**
 * Is this amount above the business's threshold for this key? Fails closed: no threshold, or
 * one in another currency, counts as above.
 */
export function overThreshold(settings: WithApprovals, key: string, amount: Money): boolean {
  const limit = approvalThreshold(settings, key);
  if (!limit || limit.currency !== CurrencyCode.parse(amount.currency)) return true;
  return amount.minor > limit.minor;
}

/**
 * Who decides this amount, by the business's bands for this key: the first band whose `upTo`
 * (same currency) is at least the amount, or that has no `upTo`. Undefined when no band fits.
 */
export function bandApprover(
  settings: WithApprovals,
  key: string,
  amount: Money | undefined,
): BandApprover | undefined {
  if (!amount) return undefined;
  for (const band of settings.approvals?.bands[key] ?? []) {
    if (!band.upTo) return band.approver;
    if (band.upTo.currency === amount.currency && amount.minor <= band.upTo.minor)
      return band.approver;
  }
  return undefined;
}
