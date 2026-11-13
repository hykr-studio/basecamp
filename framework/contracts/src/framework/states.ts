// State machines (B6): an entity's states, the transitions between them and the SLAs that run
// while a record sits in a state, declared on its spec (`traits.states`). Isomorphic: the server
// enforces them (the `states` plugin and the transition operation in @hykr/core), the apps draw
// badges and buttons from them, and the assistant's transition tool lists the moves.
// docs/decisions/B6B4.md.
import { type Labels, type Lang, pick } from '@hykr/i18n';
import { z } from 'zod';
import { reserveRoutes } from '../catalog.js';
import type { Principal } from '../principal.js';
import type { ApprovalRule, EntitySpec } from './spec.js';

/** A length of time: minutes or hours ('30m', '48h'), or milliseconds. */
export type Duration = number | `${number}m` | `${number}h`;

/** Milliseconds in a duration. Throws on anything else, so a typo stops the start. */
export function durationMs(d: Duration): number {
  if (typeof d === 'number') {
    if (!Number.isSafeInteger(d) || d <= 0) throw new Error(`"${d}" is not a duration`);
    return d;
  }
  const m = /^(\d+(?:\.\d+)?)(m|h)$/.exec(d);
  if (!m) throw new Error(`"${d}" is not a duration: say '30m' or '48h'`);
  const ms = Math.round(Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 60_000));
  if (ms <= 0) throw new Error(`"${d}" is not a duration`);
  return ms;
}

/** One state: what people call it, and whether nothing leaves it. */
export interface StateDecl {
  label?: Labels;
  /** Nothing moves out of it (checked: no transition may start here). */
  terminal?: boolean;
}

/** A refusal from a transition's guard: a stable rule code and a reason in plain words. */
export type GuardRefusal = { rule: string; reason: string };

/** One move between states, and what it takes. */
export interface TransitionDecl {
  /** Unique in the entity, a verb: 'submit', 'approve'. */
  name: string;
  /** The state, or states, it starts from. */
  from: string | readonly string[];
  to: string;
  /** What its button says ("Submit"). Default: the name. */
  label?: Labels;
  /**
   * Who may ask for it: everyone (people and the assistant, the default), people only
   * ('human'), or only the server's own work, such as an SLA's escalation ('system').
   */
  expose?: 'all' | 'human' | 'system';
  /** A capability the person needs (the assistant needs it for the person it acts for). */
  can?: string;
  /** Fields the request must carry, not empty: a reason. Each must also be in `fields`. */
  requires?: readonly string[];
  /** Fields of the update schema it may set as it moves (a reason, a date). */
  fields?: readonly string[];
  /**
   * A last check on the record and the request: refuse with a rule and a reason, or null. Pure:
   * it runs wherever the transition is checked (the server, and the app to grey a button).
   */
  guard?: (
    row: Readonly<Record<string, unknown>>,
    input: Readonly<Record<string, unknown>>,
    p: Principal,
  ) => GuardRefusal | null;
  /** When it waits for someone to approve it, and who decides (the object form). */
  approval?: ApprovalRule;
  /**
   * What is at stake: one of the application's approval levels (`defineApprovalLevel`). Its
   * policy, with the business's settings, says whether the move waits and for whom, and a park
   * names it. Without it, only `approval` makes the move wait.
   */
  level?: string;
  /** The event it stores. Default: '<entity>.<name>'. */
  event?: string;
}

/** What an SLA does when its time is up. */
export interface SlaEscalation {
  /**
   * Who should hear about it: holders of these capabilities, carried on the breach event for the
   * application's notification (`{ capability }` recipients).
   */
  notify?: readonly string[];
  /** A transition out of the SLA's state, run by the server itself. */
  transition?: string;
}

/** A clock that runs while a record is in one state. */
export interface SlaDecl {
  /** Unique in the application, owner-prefixed: 'orders.decision'. Settings override it by name. */
  name: string;
  /** It starts when a record enters this state and ends when it leaves. */
  state: string;
  within: Duration;
  /** Count every hour (default), or only the business's open hours (settings `businessHours`). */
  hours?: 'business' | 'all';
  escalate?: SlaEscalation;
}

/** An entity's state machine. */
export interface StatesTrait {
  /** The field holding the state: in the read and update schemas, a text column. */
  field: string;
  /** Where every new record starts. */
  initial: string;
  /** Every state, in the order people read them. */
  states: Readonly<Record<string, StateDecl>>;
  transitions: readonly TransitionDecl[];
  slas?: readonly SlaDecl[];
}

declare module './traits.js' {
  interface EntityTraits {
    states?: StatesTrait;
  }
}

// POST /api/transitions/:entity/:id/:transition (the states feature in @hykr/api).
reserveRoutes('transitions');

/** The spec's state machine, if it has one. */
export const statesOf = (spec: Pick<EntitySpec, 'traits'>): StatesTrait | undefined =>
  spec.traits?.states;

const fromList = (t: TransitionDecl): readonly string[] =>
  typeof t.from === 'string' ? [t.from] : t.from;

/** Does this transition start from this state? */
export const startsFrom = (t: TransitionDecl, state: unknown): boolean =>
  typeof state === 'string' && fromList(t).includes(state);

/** The transitions out of a state, in declaration order. */
export const transitionsFrom = (trait: StatesTrait, state: unknown): TransitionDecl[] =>
  trait.transitions.filter((t) => startsFrom(t, state));

export const transitionNamed = (trait: StatesTrait, name: string): TransitionDecl | undefined =>
  trait.transitions.find((t) => t.name === name);

/** Is there a declared move from one state to another (any name)? */
export const canMove = (trait: StatesTrait, from: unknown, to: unknown): boolean =>
  trait.transitions.some((t) => startsFrom(t, from) && t.to === to);

/** "awaiting_payment" → "Awaiting payment". */
const humanize = (key: string) => {
  const words = key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** What people call a state in their language: its label, or its name made readable. */
export function stateLabel(trait: StatesTrait, state: string, lang: Lang): string {
  const label = trait.states[state]?.label;
  return label ? pick(label, lang) : humanize(state);
}

/** What a transition's button says. */
export const transitionLabel = (t: TransitionDecl, lang: Lang): string =>
  t.label ? pick(t.label, lang) : humanize(t.name);

/** The event a transition stores: its own name, or '<entity>.<transition>'. */
export const transitionEvent = (entity: string, t: TransitionDecl): string =>
  t.event ?? `${entity}.${t.name}`;

/** The SLAs that run in a state. */
export const slasIn = (trait: StatesTrait, state: unknown): SlaDecl[] =>
  (trait.slas ?? []).filter((s) => s.state === state);

const NAME = /^[a-z][a-zA-Z0-9_-]*$/;
const SLA_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
// What CRUD events are named: a transition's event must not pass for one.
const CRUD = new Set(['created', 'updated', 'deleted']);

/**
 * Check a spec's state machine: every state it names exists, names are unique, a terminal state
 * has no way out, every SLA's escalation can leave its state, and the state field is in the read
 * and update schemas. Throws one error listing every problem. The server checks every served
 * entity at start.
 */
export function checkStates(spec: EntitySpec): void {
  const trait = statesOf(spec);
  if (!trait) return;
  const problems: string[] = [];
  const states = Object.keys(trait.states);
  const known = (s: string) => states.includes(s);
  if (!states.length) problems.push('it has no states');
  if (!known(trait.initial)) problems.push(`its initial state "${trait.initial}" is not a state`);
  const read = spec.schemas.read.shape as Record<string, unknown>;
  const update = spec.schemas.update.shape as Record<string, unknown>;
  if (!(trait.field in read)) problems.push(`the read schema has no "${trait.field}"`);
  if (!(trait.field in update))
    problems.push(`the update schema has no "${trait.field}" (a transition writes it)`);
  const names = new Set<string>();
  for (const t of trait.transitions) {
    if (!NAME.test(t.name)) problems.push(`"${t.name}" is not a transition name`);
    if (names.has(t.name)) problems.push(`the transition "${t.name}" is declared twice`);
    names.add(t.name);
    for (const s of [...fromList(t), t.to])
      if (!known(s)) problems.push(`the transition "${t.name}" names "${s}", which is not a state`);
    if (!fromList(t).length) problems.push(`the transition "${t.name}" starts from nowhere`);
    for (const s of fromList(t))
      if (trait.states[s]?.terminal)
        problems.push(`the transition "${t.name}" leaves "${s}", a terminal state`);
    for (const f of t.fields ?? [])
      if (!(f in update))
        problems.push(`the transition "${t.name}" sets "${f}", not in the update schema`);
    for (const f of t.requires ?? [])
      if (!(t.fields ?? []).includes(f))
        problems.push(`the transition "${t.name}" requires "${f}": list it in its fields too`);
    if ((t.fields ?? []).includes(trait.field))
      problems.push(`the transition "${t.name}" may not set the state field itself`);
    if ((t.fields ?? []).includes('transition'))
      problems.push(`the transition "${t.name}" sets "transition", the name a request carries`);
    const event = transitionEvent(spec.name, t);
    if (CRUD.has(event.split('.').at(-1) ?? '') && event.startsWith(`${spec.name}.`))
      problems.push(`the transition "${t.name}" would store "${event}", a CRUD event's name`);
  }
  const slas = new Set<string>();
  for (const s of trait.slas ?? []) {
    if (!SLA_NAME.test(s.name)) problems.push(`"${s.name}" is not an SLA name`);
    if (slas.has(s.name)) problems.push(`the SLA "${s.name}" is declared twice`);
    slas.add(s.name);
    if (!known(s.state)) problems.push(`the SLA "${s.name}" runs in "${s.state}", not a state`);
    try {
      durationMs(s.within);
    } catch (e) {
      problems.push(`the SLA "${s.name}": ${(e as Error).message}`);
    }
    const out = s.escalate?.transition;
    if (out) {
      const t = transitionNamed(trait, out);
      if (!t) problems.push(`the SLA "${s.name}" escalates by "${out}", not a transition`);
      else if (!startsFrom(t, s.state))
        problems.push(
          `the SLA "${s.name}" escalates by "${out}", which does not leave "${s.state}"`,
        );
      else if ((t.requires ?? []).length)
        problems.push(`the SLA "${s.name}" escalates by "${out}", which requires fields`);
    }
  }
  if (problems.length) throw new Error(`${spec.name}'s states: ${problems.join('; ')}`);
}

/** The body of POST /api/transitions/:entity/:id/:transition: the transition's own fields. */
export const TransitionBody = z.record(z.string(), z.unknown());
export type TransitionBody = z.infer<typeof TransitionBody>;
