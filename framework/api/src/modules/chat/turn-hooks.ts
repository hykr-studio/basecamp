import { HttpException, Logger } from '@nestjs/common';
import {
  type TurnHook,
  type TurnInfo,
  type TurnOutcome,
  type TurnRefusal,
  turnHooks,
} from '../../hooks.js';

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

/** The framework's own first hook: without a model key, outside the scripted model, no turn. */
export const modelKeyHook: TurnHook = {
  name: 'model-key',
  before: async () =>
    process.env.MODEL_MODE !== 'fake' && !process.env.OPENROUTER_API_KEY
      ? {
          refuse: {
            rule: 'model_not_configured',
            reason: 'Set OPENROUTER_API_KEY in .env to use the assistant',
            status: 503,
          },
        }
      : null,
};

/** The framework's hooks, then the registry's, in order. */
const hooksInOrder = () => [modelKeyHook, ...turnHooks.all()];

/** What the hooks decided for a turn that may run. */
export type TurnShape = { context: string[]; model?: string; withoutTools: string[] };

/**
 * Every hook's `before`, in order. The first refusal throws TurnRefused; a hook that throws fails
 * the turn (fail closed). Context lines join in order, the first model named wins, and tools
 * taken away add up.
 */
export async function gateTurn(turn: TurnInfo): Promise<TurnShape> {
  const shape: TurnShape = { context: [], withoutTools: [] };
  for (const hook of hooksInOrder()) {
    const gate = await hook.before?.(turn);
    if (!gate) continue;
    if ('refuse' in gate) {
      log.warn(`run=${turn.runId} refused by ${hook.name}: ${gate.refuse.rule}`);
      throw new TurnRefused(gate.refuse);
    }
    shape.context.push(...(gate.context ?? []));
    shape.model ??= gate.model;
    shape.withoutTools.push(...(gate.withoutTools ?? []));
  }
  return shape;
}

/** Every hook's `after`. A failure is logged, never shown to the person. */
export async function afterTurn(turn: TurnInfo, outcome: TurnOutcome) {
  for (const hook of hooksInOrder()) {
    if (!hook.after) continue;
    await hook.after(turn, outcome).catch((e) => {
      log.error(
        `run=${turn.runId} ${hook.name}.after failed: ${e instanceof Error ? e.message : e}`,
      );
    });
  }
}
