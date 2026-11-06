// The model gateway and each business's model policy (A10) as an application meets them: a turn
// hook that asks for a model ("use model <ref> …"), a write hook that parks a policy allowing the
// fixture's big model, a tool that tells which model the turn runs on, and a script for it. The
// deployment's models come from MODEL_PROVIDERS, which the models e2e test points at its stub
// gateway (gateway.ts). Only the models e2e test boots `modelsApp`.
import { call, defineScript, say } from '@hykr/agents/script';
import {
  defineModule,
  defineServer,
  type TurnHook,
  type TurnInfo,
  type TurnOutcome,
} from '@hykr/api';
import { type Contributions, type ModelPolicy, moduleSpec } from '@hykr/contracts';
import { needsApproval, type WriteHook } from '@hykr/core';
import type { ToolContribution } from '@hykr/core/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { fixture } from '../../index.js';

/** The ref a policy must not allow without an approval. */
export const BIG_MODEL = 'stub/big';

/** What each piece saw: the tests read it (the app runs in the test's process). */
export const seen = {
  before: [] as TurnInfo[],
  after: [] as { turn: TurnInfo; outcome: TurnOutcome }[],
};

/** "use model <ref> …": this turn asks for that model. Every turn is kept in `seen`. */
export const AskForModel: TurnHook = {
  name: 'fixture.models.ask',
  before: async (turn) => {
    seen.before.push({ ...turn });
    const asked = /^use model ([^\s,]+)/i.exec(turn.message.trim())?.[1];
    return asked ? { model: asked } : null;
  },
  after: async (turn, outcome) => {
    seen.after.push({ turn: { ...turn }, outcome });
  },
};

/** A policy that allows the big model waits for an approval. */
export const ParkBigModel: WriteHook = {
  name: 'fixture.models.park',
  decide: ({ op, input }) =>
    op.name === 'models.policy.set' && (input as ModelPolicy).allowed.includes(BIG_MODEL)
      ? needsApproval('fixture_big_model', 'Allowing the big model needs an approval')
      : null,
};

/** turn-model: the model this turn runs on and the business it is for, as the agent sees them. */
export const ModelTools: ToolContribution = {
  name: 'fixture.models.tools',
  tools: () => ({
    'turn-model': createTool({
      id: 'turn-model',
      description: 'Which model this turn runs on.',
      inputSchema: z.object({}),
      execute: async (_input, ctx) => ({
        ok: true,
        result: {
          model: ctx?.requestContext?.get('model') ?? null,
          tenantId: ctx?.requestContext?.get('tenantId') ?? null,
        },
      }),
    }),
  }),
};

/** "… which model": calls turn-model and says what it found. */
export const modelScripts = [
  defineScript({
    name: 'which-model',
    match: (text) => (/which model/i.test(text) ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('turn-model');
      if (!r) return [call('turn-model', {})];
      return [say(`Model: ${(r.result as { model: string | null }).model ?? 'none'}.`)];
    },
  }),
];

export const modelsContributions: Partial<Contributions> = {
  turnHooks: [AskForModel],
  writeHooks: [ParkBigModel],
  toolContributions: [ModelTools],
};

/** The script lives in a module of its own, after the fixture's. */
export const modelsModule = defineModule({
  ...moduleSpec({ name: 'model_checks', dependsOn: ['tasks'], entities: {}, commands: [] }),
  agent: { scripts: modelScripts },
});

/** The fixture, with everything above. */
export const modelsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, modelsModule],
  contributes: modelsContributions,
});
