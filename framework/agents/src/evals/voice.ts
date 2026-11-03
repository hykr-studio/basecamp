// Spoken turns in English, Hindi and Telugu, scored on three things: the right tools with the
// title as said, an answer in the turn's language, and at most two sentences.
// `basecamp eval voice` (scripted model) or `basecamp eval voice --live`.
//
// Like a voice session in the app: surfaces inline + canvas + speech, channel voice, and the
// language pinned per turn. Needs the API running.
import type { Surface } from '@hykr/contracts';
import type { Agents } from '../agents.js';
import { briefForVoice, expectedOutcome, listBeforeWrite, repliesInLanguage } from '../scorers.js';
import { prepare, report, runCases } from './harness.js';

const SPOKEN: Surface[] = ['inline', 'canvas', 'speech'];

export async function evalVoice(agents: Agents): Promise<boolean> {
  const cases = (agents.domain.voiceEvalCases ?? []).map((c) => ({
    ...c,
    surfaces: c.surfaces ?? SPOKEN,
  }));
  const userId = await prepare(agents, 'spoken turns');
  return report(
    await runCases(
      agents,
      userId,
      cases,
      [expectedOutcome, listBeforeWrite(agents.catalog.commands), repliesInLanguage, briefForVoice],
      (c, ctx) => {
        ctx.set('lang', c.lang);
        ctx.set('channel', 'voice');
      },
      (c) => ({ ...c.expect, lang: c.lang }),
    ),
  );
}
