// Spoken turns in English, Hindi and Telugu, scored on three things: the right tools with the
// title as said, an answer in the turn's language, and at most two sentences.
//
//   pnpm --filter @app/agents eval:voice        scripted model (CI)
//   pnpm --filter @app/agents eval:voice:live   your AGENT_MODEL
//
// Like a voice session in the app: surfaces inline + canvas + speech, channel voice, and the
// language pinned per turn. Needs the API running. Exits 1 if any turn misses.
import type { Surface } from '@app/contracts';
import { agentDomain } from '../src/domain/index.js';
import {
  briefForVoice,
  expectedOutcome,
  listBeforeWrite,
  repliesInLanguage,
} from '../src/scorers.js';
import { prepare, report, runCases } from './harness.js';

const SPOKEN: Surface[] = ['inline', 'canvas', 'speech'];
const cases = (agentDomain.voiceEvalCases ?? []).map((c) => ({
  ...c,
  surfaces: c.surfaces ?? SPOKEN,
}));

const userId = await prepare('spoken turns');
report(
  await runCases(
    userId,
    cases,
    [expectedOutcome, listBeforeWrite, repliesInLanguage, briefForVoice],
    (c, ctx) => {
      ctx.set('lang', c.lang);
      ctx.set('channel', 'voice');
    },
    (c) => ({ ...c.expect, lang: c.lang }),
  ),
);
