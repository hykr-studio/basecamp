import {
  type AuthorizeResult,
  canMove,
  type EntitySpec,
  type StatesTrait,
  stateLabel,
  statesOf,
  transitionsFrom,
  type WriteAction,
} from '@hykr/contracts';
import { deny, RuleDenied } from '../authorize.js';
import type { EntityPlugin } from '../hooks.js';

type Values = Record<string, unknown>;

const moves = (trait: StatesTrait, row: Values | null, input: Values | null) => {
  const to = input?.[trait.field];
  return to !== undefined && (row === null || to !== row[trait.field]);
};

/** The refusal of a write that moves the state field the wrong way, or null. */
function refusal(
  spec: EntitySpec,
  trait: StatesTrait,
  action: WriteAction,
  row: Values | null,
  input: Values | null,
  crud: boolean,
): AuthorizeResult | null {
  if (action === 'create') {
    const given = input?.[trait.field];
    return given !== undefined && given !== trait.initial
      ? deny(
          'state_initial',
          `A new ${spec.label} starts as ${stateLabel(trait, trait.initial, 'en').toLowerCase()}`,
        )
      : null;
  }
  if (action !== 'update' || !row || !moves(trait, row, input)) return null;
  const from = row[trait.field];
  if (crud) {
    const ways = transitionsFrom(trait, from).map((t) => t.name);
    return deny(
      'state_through_transition',
      `A ${spec.label}'s ${trait.field} changes through its transitions${ways.length ? ` (${ways.join(', ')})` : ''}`,
    );
  }
  return canMove(trait, from, input?.[trait.field])
    ? null
    : deny(
        'no_such_transition',
        `A ${spec.label} can't go from ${String(from)} to ${String(input?.[trait.field])}`,
      );
}

/**
 * The state field of an entity with `traits.states`: a new record starts in the initial state,
 * plain CRUD never moves it (a transition does: `<entity>.transition`), and a command moves it
 * only along a declared transition. Who may move it, guards and approvals are the transition's
 * (`transitionOp`, or `transition()` inside a command).
 */
export const statesPlugin: EntityPlugin = {
  name: 'states',
  appliesTo: (spec) => statesOf(spec) !== undefined,
  // CRUD: refused at the decision, so the refusal is audited before anything runs.
  decide: (_p, action, row, input, { spec }) => {
    const trait = statesOf(spec);
    return trait ? refusal(spec, trait, action, row, input, true) : null;
  },
  // Every repository write (commands, the transition operation): the same, and the initial state.
  toValues: (values, { action, row, input }, { spec }) => {
    const trait = statesOf(spec);
    if (!trait) return values;
    const r = refusal(spec, trait, action, row, input, false);
    if (r) throw new RuleDenied(r);
    return action === 'create' ? { ...values, [trait.field]: trait.initial } : values;
  },
};
