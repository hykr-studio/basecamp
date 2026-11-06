// Transitions (B6): a record moving from one state to another along its spec's state machine,
// as one write through runWrite. `transitionOp` is the operation behind the route and the tool
// (`<entity>.transition`, parked and replayed like any write); `transition()` is the same move
// inside a command's run. docs/decisions/B6B4.md.
import {
  type AuthorizeResult,
  type Principal,
  parksFor,
  type StatesTrait,
  startsFrom,
  stateLabel,
  statesOf,
  type TransitionDecl,
  transitionEvent,
  transitionLabel,
  transitionNamed,
} from '@hykr/contracts';
import { can } from '@hykr/policy';
import { NotFoundException } from '@nestjs/common';
import { and, type Column, eq, getTableColumns, sql, type Table } from 'drizzle-orm';
import { z } from 'zod';
import { allow, deny, needsApproval, RuleDenied } from '../authorize.js';
import type { NamedEvent } from '../entity/cqrs-classes.js';
import { type AnyEntityDef, type RuleContext, tenantOf } from '../entity/define-entity.js';
import { entityDefs } from '../entity/registry.js';
import type { Tx } from '../tokens.js';
import { checkPins, type Pins, pinsOf, versionNote } from '../versions/pins.js';
import { registerOp } from '../write/approvals.js';
import type { Touched, WriteOp } from '../write/pipeline.js';

type Values = Record<string, unknown>;

/**
 * A record moved along its state machine: '<entity>.<transition>' (or the transition's own
 * event), with the row after and before. Stored in the outbox with the write and published in
 * the process after commit, so notifications and subscribers can follow a stage.
 */
export class TransitionEvent implements NamedEvent {
  constructor(
    readonly eventName: string,
    readonly resourceType: string,
    readonly row: Values,
    readonly before: Values,
    /** The transition's name, and the states it moved between. */
    readonly transition: { name: string; from: string; to: string },
  ) {}
  get resourceId(): string {
    return String(this.row.id);
  }
}

/** The state machine of a served entity, or an error naming it. */
export function machineOf(def: AnyEntityDef): StatesTrait {
  const trait = statesOf(def.spec);
  if (!trait) throw new Error(`${def.name} has no states`);
  return trait;
}

/** The via a transition's own writes carry, for the entity's rules. */
export const transitionVia = (def: AnyEntityDef): RuleContext => ({
  via: `${def.name}.transition`,
});

const empty = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** What a record is called in a summary: its title or name, else its label. */
const nameOf = (row: Values) => {
  const n = row.title ?? row.name ?? row.number;
  return typeof n === 'string' && n ? `"${n}"` : '';
};

/**
 * Whether this transition may run on this record for this principal, apart from approval: it
 * starts from the record's state, the principal may ask for it (expose, capability), the
 * request carries what it requires, and its guard has no objection. `who: false` skips the
 * expose and capability checks (a command decides who runs it).
 */
export function checkTransition(
  def: AnyEntityDef,
  t: TransitionDecl,
  row: Values,
  input: Values,
  p: Principal,
  opts: { who: boolean } = { who: true },
): AuthorizeResult | null {
  const trait = machineOf(def);
  const label = def.spec.label;
  const verb = transitionLabel(t, 'en');
  const state = row[trait.field];
  if (!startsFrom(t, state))
    return deny(
      'not_from_state',
      `A ${label} that is ${stateLabel(trait, String(state), 'en').toLowerCase()} can't take "${verb}"`,
    );
  if (opts.who) {
    const expose = t.expose ?? 'all';
    if (expose === 'system' && p.actor.kind !== 'system')
      return deny('system_only', `"${verb}" happens on its own; nobody asks for it`);
    if (expose === 'human' && p.actor.kind === 'agent')
      return deny('humans_only', `Only people can ${verb.toLowerCase()} a ${label}`);
    if (t.can && p.actor.kind !== 'system' && !can(p, t.can))
      return deny('transition_not_allowed', `You can't ${verb.toLowerCase()} a ${label}`);
  }
  for (const field of t.requires ?? [])
    if (empty(input[field]))
      return deny('transition_requires', `To ${verb.toLowerCase()} a ${label}, give its ${field}`);
  const refused = t.guard?.(row, input, p);
  if (refused) return deny(refused.rule, refused.reason);
  return null;
}

/** The fields a transition takes with it, from the entity's update schema; nothing else. */
export function transitionInput(def: AnyEntityDef, t: TransitionDecl | undefined): z.ZodObject {
  const shape = def.spec.schemas.update.shape as Record<string, z.ZodType>;
  const fields = Object.fromEntries(
    (t?.fields ?? []).filter((f) => shape[f]).map((f) => [f, shape[f] as z.ZodType]),
  );
  return z.object(fields);
}

/**
 * What the transition operation takes: the transition's fields, and its own name (filled in
 * when left out), so a parked request says which move it is (the approval card draws it).
 */
const operationInput = (def: AnyEntityDef, t: TransitionDecl | undefined, name: string) =>
  transitionInput(def, t)
    .extend({ transition: z.literal(name).default(name) })
    // Anything else is a mistake: refused (400), never silently dropped.
    .strict();

/** The update a transition makes, its touched row and its event. */
async function apply(
  tx: Tx,
  p: Principal,
  def: AnyEntityDef,
  row: Values,
  t: TransitionDecl,
  input: Values,
  via: RuleContext,
): Promise<{ row: Values; touched: Touched[]; events: object[] }> {
  const trait = machineOf(def);
  const fields = Object.fromEntries(
    (t.fields ?? []).filter((f) => input[f] !== undefined).map((f) => [f, input[f]]),
  );
  const after = (await def.repo.update(
    tx,
    p,
    row as never,
    { ...fields, [trait.field]: t.to },
    via,
  )) as Values;
  const from = String(row[trait.field]);
  return {
    row: after,
    touched: [{ type: def.name, id: String(row.id), change: 'updated', before: row, after }],
    events: [
      new TransitionEvent(transitionEvent(def.name, t), def.name, after, row, {
        name: t.name,
        from,
        to: t.to,
      }),
    ],
  };
}

/**
 * Move a record along a transition inside a command's run: the same checks as the transition
 * operation (it starts from the record's state, what it requires, its guard), then the update,
 * with the command's `via`. Who may run it and whether it waits are the command's `authorize`.
 * Return its `touched` and `events` with the command's own.
 */
export async function transition(
  tx: Tx,
  p: Principal,
  def: AnyEntityDef,
  row: Values,
  name: string,
  opts: { via: RuleContext; input?: Values },
): Promise<{ row: Values; touched: Touched[]; events: object[] }> {
  const t = transitionNamed(machineOf(def), name);
  if (!t) throw new Error(`${def.name} has no transition "${name}"`);
  const input = transitionInput(def, t).parse(opts.input ?? {}) as Values;
  const refused = checkTransition(def, t, row, input, p, { who: false });
  if (refused) throw new RuleDenied(refused);
  return apply(tx, p, def, row, t, input, opts.via);
}

/** Thrown inside the savepoint of a write probe: it went through, now undo it. */
class ProbeDone extends Error {}

/**
 * Can p write this record? Tried, in a savepoint that is rolled back: the entity's own write
 * scope and rules answer (404 when it is not theirs to write, a rule's refusal). Nothing of the
 * try is kept. `define-entity.ts` keeps access to itself; this uses only its repository.
 */
export async function assertWritable(
  tx: Tx,
  p: Principal,
  def: AnyEntityDef,
  row: Values,
  via: RuleContext,
): Promise<void> {
  const trait = statesOf(def.spec);
  const key = trait?.field ?? Object.keys(def.spec.schemas.update.shape)[0];
  if (!key) return;
  try {
    await tx.transaction(async (sp) => {
      await def.repo.update(sp as Tx, p, row as never, { [key]: row[key] }, via);
      throw new ProbeDone();
    });
  } catch (e) {
    if (!(e instanceof ProbeDone)) throw e;
  }
}

/**
 * Hold the row until the write commits, so two transitions of one record run one after the
 * other and the second sees the first's state. Only within the principal's business; the
 * scoped read that follows decides whether it is theirs.
 */
async function lock(tx: Tx, p: Principal, def: AnyEntityDef, id: string) {
  const cols = getTableColumns(def.table) as Record<string, Column>;
  await tx
    .select({ id: sql<string>`${cols.id}` })
    .from(def.table as Table)
    .where(and(eq(cols.id as Column, id), eq(cols.tenantId as Column, tenantOf(p))))
    .for('update');
}

/**
 * The operation behind POST /api/transitions/:plural/:id/:transition and the assistant's
 * transition tool: `<entity>.transition`, with `{ id, transition }` (and, once parked, the pins
 * of the record) as its args and the transition's fields as its input. It loads and locks the
 * record (404 if not theirs), checks they may write it, then the transition's checks and its
 * approval (parks at its tier, decided by its approval rule's deciders), and moves it.
 */
export function transitionOp(
  def: AnyEntityDef,
  args: Record<string, unknown> | null,
): WriteOp<Values, Values, Values> {
  const trait = machineOf(def);
  const id = String(args?.id ?? '');
  const name = String(args?.transition ?? '');
  const t = transitionNamed(trait, name);
  const pinned = args?.pins as Pins | undefined;
  let pins = pinned;
  const via = transitionVia(def);
  const label = def.spec.label;
  return {
    name: `${def.name}.transition`,
    kind: 'command',
    resourceType: def.name,
    resourceId: () => id || null,
    input: operationInput(def, t, name) as unknown as z.ZodType<Values>,
    get args() {
      return { id, transition: name, ...(pins ? { pins } : {}) };
    },
    approval: t?.approval,
    async load(tx, p) {
      if (!t)
        throw new NotFoundException({
          error: 'not_found',
          message: `A ${label} has no transition "${name}"`,
        });
      await lock(tx, p, def, id);
      const row = (await def.repo.get(tx, p, id)) as Values;
      if (pinned) checkPins([{ def, row }], pinned);
      else pins = pinsOf([{ def, row }]);
      await assertWritable(tx, p, def, row, via);
      return row;
    },
    authorize(p, row, input) {
      const decl = t as TransitionDecl;
      const refused = checkTransition(def, decl, row, input, p);
      if (refused) return refused;
      if (parksFor(decl.approval, p, { action: decl.name, input, row }))
        return needsApproval(
          `${def.name}_${decl.name}_needs_approval`,
          `"${transitionLabel(decl, 'en')}" on a ${label} waits for approval`,
          decl.tier !== undefined ? { tier: decl.tier } : undefined,
        );
      return allow(`${def.name}_${decl.name}`, `${transitionLabel(decl, 'en')} a ${label}`);
    },
    summarize(_input, row) {
      const decl = t as TransitionDecl;
      const version = versionNote(def, row);
      const from = stateLabel(trait, String(row[trait.field]), 'en').toLowerCase();
      const to = stateLabel(trait, decl.to, 'en').toLowerCase();
      return [
        `${transitionLabel(decl, 'en')} ${label}`,
        nameOf(row),
        version ? `(${version})` : '',
        `: ${from} → ${to}`,
      ]
        .filter(Boolean)
        .join(' ')
        .replace(' :', ':');
    },
    async run({ tx, principal, input, loaded: row }) {
      const out = await apply(tx, principal, def, row, t as TransitionDecl, input, via);
      return { value: out.row, touched: out.touched, events: out.events };
    },
    present: (row, p) => def.toRead(row as never, p),
  };
}

/** The served entity with states whose plural (or name) this is, or undefined. */
export function statesEntity(pluralOrName: string): AnyEntityDef | undefined {
  return entityDefs().find(
    (d) => (d.plural === pluralOrName || d.name === pluralOrName) && statesOf(d.spec),
  );
}

/**
 * Make every served entity with states replayable: `<entity>.transition` joins the operations
 * an approval can replay. Call once the entities are served (the states feature does, at
 * start); a command with that name stops the start.
 */
export function serveTransitions(): readonly AnyEntityDef[] {
  const served = entityDefs().filter((d) => statesOf(d.spec));
  for (const def of served)
    registerOp(`${def.name}.transition`, (args) => transitionOp(def, args), def);
  return served;
}
