import { HttpException, Logger } from '@nestjs/common';
import { type TurnInfo, type TurnOutcome, type TurnRefusal, turnHooks } from '../../hooks.js';

const log = new Logger('TurnHooks');

/** A turn a hook refused: the caller gets its status and `{ error: 'turn_refused', rule, reason }`. */
export class TurnRefused extends HttpException {
  constructor(readonly refusal: TurnRefusal) {
    super(
      { error: 'turn_refused', rule: refusal.rule, reason: refusal.reason },
      refusal.status ?? 403,
    );
  }
}

/**
 * What picks a turn's model: the `models` feature's ModelPolicyService, which registers itself
 * when it starts (`setModelGate`). Without one, no turn runs.
 */
export interface ModelGate {
  /** Before the hooks run: can this deployment run any turn at all? null: yes. */
  ready(turn: TurnInfo): TurnRefusal | null;
  /** After them: the model for this turn (`requested`: a hook's), or why none may run. */
  choose(turn: TurnInfo, requested?: string): Promise<{ ref: string } | { refuse: TurnRefusal }>;
}

let modelGate: ModelGate | undefined;

/** Install (or, with nothing, remove) what picks each turn's model. */
export function setModelGate(gate?: ModelGate) {
  modelGate = gate;
}

/** What the hooks and the model policy decided for a turn that may run. */
export type TurnShape = { context: string[]; model: string; withoutTools: string[] };

const NO_GATE: TurnRefusal = {
  rule: 'model_not_configured',
  reason: 'No model policy is loaded (the models feature)',
  status: 503,
};

function refused(turn: TurnInfo, by: string, refusal: TurnRefusal): never {
  log.warn(`run=${turn.runId} refused by ${by}: ${refusal.rule}`);
  throw new TurnRefused(refusal);
}

/**
 * Whether the deployment has a model, then every hook's `before`, in order, then the business's
 * model policy. The first refusal throws TurnRefused; a hook that throws fails the turn (fail
 * closed). Context lines join in order, the first model a hook names is the one asked for, and
 * tools taken away add up. The policy chooses the turn's model (the one asked for, else the
 * business's own, else the deployment's default) or refuses the turn: nothing falls back to
 * another model. The choice is set on `turn.model`, for the `after` hooks.
 */
export async function gateTurn(turn: TurnInfo): Promise<TurnShape> {
  const gate = modelGate;
  if (!gate) refused(turn, 'models', NO_GATE);
  const unready = gate.ready(turn);
  if (unready) refused(turn, 'models', unready);
  const context: string[] = [];
  const withoutTools: string[] = [];
  let requested: string | undefined;
  for (const hook of turnHooks.all()) {
    const said = await hook.before?.(turn);
    if (!said) continue;
    if ('refuse' in said) refused(turn, hook.name, said.refuse);
    context.push(...(said.context ?? []));
    requested ??= said.model;
    withoutTools.push(...(said.withoutTools ?? []));
  }
  const chosen = await gate.choose(turn, requested);
  if ('refuse' in chosen) refused(turn, 'models', chosen.refuse);
  turn.model = chosen.ref;
  return { context, model: chosen.ref, withoutTools };
}

/** Every hook's `after`. A failure is logged, never shown to the person. */
export async function afterTurn(turn: TurnInfo, outcome: TurnOutcome) {
  for (const hook of turnHooks.all()) {
    if (!hook.after) continue;
    await hook.after(turn, outcome).catch((e) => {
      log.error(
        `run=${turn.runId} ${hook.name}.after failed: ${e instanceof Error ? e.message : e}`,
      );
    });
  }
}
