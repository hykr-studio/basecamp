// Spoken turns in the application's languages, scored on three things: the right tools with the
// title as said, an answer in the turn's language, and at most two sentences.
// `basecamp eval voice [--module <m>]` (scripted model) or `basecamp eval voice --live`.
//
// Like a voice session in the app: surfaces inline + canvas + speech, channel voice, and the
// language pinned per turn. Needs the API running.
import type { Surface } from '@hykr/contracts';
import type { Agents } from '../agents.js';
import { suitesFor } from '../modules.js';
import { briefForVoice, expectedOutcome, listBeforeWrite, repliesInLanguage } from '../scorers.js';
import { nothingRan, prepare, type Row, report, runCases } from './harness.js';

const SPOKEN: Surface[] = ['inline', 'canvas', 'speech'];

export async function evalVoice(
  agents: Agents,
  options: { module?: string } = {},
): Promise<boolean> {
  const rows: Row[] = [];
  for (const suite of suitesFor(agents.domain, options.module)) {
    if (!suite.voiceEvalCases.length) continue;
    const cases = suite.voiceEvalCases.map((c) => ({ ...c, surfaces: c.surfaces ?? SPOKEN }));
    const userId = await prepare(`spoken turns (${suite.module})`, suite.evalSetup);
    rows.push(
      ...(await runCases(
        agents,
        userId,
        cases,
        [
          expectedOutcome,
          listBeforeWrite(agents.catalog.commands),
          repliesInLanguage,
          briefForVoice,
        ],
        (c, ctx) => {
          ctx.set('lang', c.lang);
          ctx.set('channel', 'voice');
        },
        (c) => ({ ...c.expect, lang: c.lang }),
      )),
    );
  }
  return report(rows, nothingRan(options.module, 'spoken eval cases (agent.voiceEvalCases)'));
}
