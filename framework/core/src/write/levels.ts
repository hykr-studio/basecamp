// Approval levels at work in the write path. The application declares its levels
// (`defineApprovalLevel` in @hykr/contracts) and which writes reach which level (level rules,
// here); a business adjusts both in its settings (`approvals`). runWrite asks the level rules
// after the operation's own decision and the write hooks, then applies the level's policy:
// whether the write waits, and how long it can be undone if it runs.
import {
  type ApprovalLevelDef,
  type AuthorizeResult,
  createHookRegistry,
  levelOf,
  type Principal,
  parseTenantSettings,
  type TenantConfig,
} from '@hykr/contracts';
import { schema } from '@hykr/db';
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { needsApproval } from '../authorize.js';
import type { Conn } from '../tokens.js';
import { strongerDecision } from './decisions.js';

declare module '@hykr/contracts' {
  interface Contributions {
    levelRules: readonly LevelRule[];
  }
}

type Values = Record<string, unknown>;

/** One write, as a level rule sees it. */
export interface LevelRuleArgs {
  p: Principal;
  /** The operation: 'todo.update', 'notify.send'. */
  op: { name: string; kind: 'entity' | 'command'; resourceType: string };
  /** Its validated input (null when it has none, a delete). */
  input: Values | null;
  /** The row it changes, for an entity's update or delete; null otherwise. */
  row: Values | null;
  /** Whatever the operation loaded (a command's own shape). */
  loaded: unknown;
  /** The business's settings, defaults applied: thresholds and bands live in `approvals`. */
  settings: TenantConfig;
}

/**
 * Which writes reach which approval level, declared by the application: usually
 * `atLevel('<level>', rule, reason, { amount })` from `decide`, or null for no opinion. The answer
 * is combined with the operation's own decision (`strongerDecision`): the higher level wins and
 * nothing is loosened, so a rule may also park or refuse.
 */
export interface LevelRule {
  /** Unique: 'todos.levels'. */
  name: string;
  /** Operation names ('todo.update'), prefixes ('todo.*'), or '*' for every write. */
  on: readonly string[];
  decide(a: LevelRuleArgs): AuthorizeResult | null;
}

const NAME = /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/;
const PATTERN = /^(?:\*|[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*(?:\.\*)?)$/;

/** A level rule, checked: its name and its patterns. */
export function defineLevelRule(rule: LevelRule): LevelRule {
  if (!NAME.test(rule.name))
    throw new Error(`The level rule name "${rule.name}" must be lower case words joined by "."`);
  if (!rule.on.length) throw new Error(`Level rule ${rule.name}: name at least one operation`);
  const bad = rule.on.find((p) => !PATTERN.test(p));
  if (bad) throw new Error(`Level rule ${rule.name}: "${bad}" is not an operation or "<prefix>.*"`);
  return rule;
}

/** Level rules, in the order they run. Collects `contributes.levelRules`. */
export const levelRules = createHookRegistry<LevelRule>(
  'level rule',
  (r) => defineLevelRule(r).name,
  { collects: 'levelRules' },
);

/** Does an `on` entry match this operation? 'todo.*' matches 'todo.update', not 'todos.x'. */
export function matchesOp(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/** The level rules that apply to this operation, in order. */
export const levelRulesFor = (opName: string): readonly LevelRule[] =>
  levelRules.all().filter((r) => r.on.some((pattern) => matchesOp(pattern, opName)));

const log = new Logger('ApprovalLevels');

/**
 * A business's settings, read in the write's own transaction so a change applies at once.
 * Settings that do not parse fall back to the defaults (the application's policy as declared,
 * and no thresholds, which `overThreshold` counts as exceeded): never looser than declared.
 */
export async function settingsIn(conn: Conn, tenantId: string | undefined): Promise<TenantConfig> {
  if (!tenantId) return parseTenantSettings(undefined);
  const [row] = await conn
    .select({ settings: schema.tenants.settings })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId));
  try {
    return parseTenantSettings(row?.settings);
  } catch (e) {
    log.warn(`Settings of business ${tenantId} do not parse; using the defaults: ${e}`);
    return parseTenantSettings(undefined);
  }
}

/** What a level does in one business: its policy as declared, with the business's changes. */
export interface EffectiveLevel {
  def: ApprovalLevelDef | undefined;
  /** Does it wait for this requester? */
  parks: boolean;
  undoMs: number;
  expiresInMs: number | undefined;
}

/**
 * A level's policy as one business applies it. A level nobody declared always parks (fail
 * closed). Otherwise: the business's `parks: true` always parks; its `parks: false` runs only
 * when the level lets a business loosen it; else the policy's `parks` (a rank 0 level runs, any
 * higher one parks). The undo window and the expiry are the business's when it set them.
 */
export function effectiveLevel(name: string, p: Principal, settings: TenantConfig): EffectiveLevel {
  const def = levelOf(name);
  if (!def) return { def, parks: true, undoMs: 0, expiresInMs: undefined };
  const policy = def.policy ?? {};
  const override = settings.approvals?.levels[name] ?? {};
  const declared =
    typeof policy.parks === 'function' ? policy.parks(p) : (policy.parks ?? def.rank > 0);
  const parks =
    override.parks === true
      ? true
      : override.parks === false && policy.tenantMayLoosen
        ? false
        : declared;
  return {
    def,
    parks,
    undoMs: override.undoMs ?? policy.undoMs ?? 0,
    expiresInMs: override.expiresInMs ?? policy.expiresInMs,
  };
}

/**
 * The level rules' say on a write, then its level's policy. Returns the final decision: an
 * allow at a level that parks becomes a park (same rule and reason); an allow at a level that
 * runs gets the level's undo window (the longer of it and the decision's own). A park or a
 * refusal is never loosened. `settings()` is only called when a level is involved.
 */
export async function applyLevels(a: {
  decision: AuthorizeResult;
  p: Principal;
  op: LevelRuleArgs['op'];
  input: unknown;
  loaded: unknown;
  settings: () => Promise<TenantConfig>;
}): Promise<AuthorizeResult> {
  let decision = a.decision;
  const rules = levelRulesFor(a.op.name);
  if (rules.length) {
    const settings = await a.settings();
    const asValues = (v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Values) : null;
    const args: LevelRuleArgs = {
      p: a.p,
      op: a.op,
      input: asValues(a.input),
      row: a.op.kind === 'entity' ? asValues(a.loaded) : null,
      loaded: a.loaded,
      settings,
    };
    for (const rule of rules) decision = strongerDecision(decision, rule.decide(args)) ?? decision;
  }
  if (decision.level === undefined || decision.decision !== 'allow') return decision;
  const level = effectiveLevel(decision.level, a.p, await a.settings());
  if (level.parks) {
    const { decision: _d, rule, reason, ...details } = decision;
    return needsApproval(rule, reason, details);
  }
  const undoMs = Math.max(decision.undoMs ?? 0, level.undoMs);
  return undoMs > 0 ? { ...decision, undoMs } : decision;
}
