// WhatsApp turns: words only (surfaces ['text'], channel whatsapp), the business-only rule, and
// the language the person writes in. Scored on the right tools and the reply's language.
// `basecamp eval whatsapp [--module <m>]` (scripted model) or `basecamp eval whatsapp --live`.
//
// The framework's own cases, then each module's turns in its other languages (not English),
// typed instead of said.
// Needs the API running.
import type { Surface } from '@hykr/contracts';
import type { Lang } from '@hykr/i18n';
import type { RequestContext } from '@mastra/core/request-context';
import type { EvalCase } from '../agent-domain.js';
import type { Agents } from '../agents.js';
import { suitesFor } from '../modules.js';
import { expectedOutcome, listBeforeWrite, repliesInLanguage } from '../scorers.js';
import { prepare, type Row, report, runCases } from './harness.js';

const TEXT: Surface[] = ['text'];
const NO_SCREEN = ['canvas', 'screen', 'tap '];
type WhatsAppCase = EvalCase & { lang: Lang };

/** The framework's cases: no business tool for an off-topic ask; a person when asked for. */
const framework = (agents: Agents): WhatsAppCase[] => [
  {
    lang: 'en',
    why: 'off-topic: no business tool, no essay',
    input: 'write me a poem about cricket',
    expect: {
      must: [],
      // No write of any kind: none of the application's creates, no template, no handoff.
      mustNot: [
        ...Object.values(agents.catalog.entities)
          .filter((spec) => spec.name !== 'page')
          .map((spec) => `create-${spec.name}`),
        'send-template',
        'request-human',
      ],
      replyExcludes: NO_SCREEN,
    },
  },
  {
    lang: 'en',
    why: 'asks for a person: handed to the team',
    input: 'I want to talk to the manager',
    expect: { must: ['request-human'], replyExcludes: NO_SCREEN },
  },
];

export async function evalWhatsapp(
  agents: Agents,
  options: { module?: string } = {},
): Promise<boolean> {
  const scorers = [expectedOutcome, listBeforeWrite(agents.catalog.commands), repliesInLanguage];
  const extra = (c: WhatsAppCase, ctx: RequestContext) => {
    ctx.set('lang', c.lang);
    ctx.set('channel', 'whatsapp');
  };
  const truth = (c: WhatsAppCase) => ({ ...c.expect, lang: c.lang });
  const rows: Row[] = [];
  // The framework's own cases belong to no module: they run when no module is named.
  const suites = suitesFor(agents.domain, options.module);
  if (options.module === undefined) {
    const userId = await prepare('WhatsApp turns (framework)');
    const cases = framework(agents).map((c) => ({ ...c, surfaces: TEXT }));
    rows.push(...(await runCases(agents, userId, cases, scorers, extra, truth)));
  }
  for (const suite of suites) {
    const typed: WhatsAppCase[] = suite.voiceEvalCases
      .filter((c) => c.lang !== 'en')
      .map((c) => ({ ...c, why: `${c.why}, typed on WhatsApp`, surfaces: TEXT }));
    if (!typed.length) continue;
    const userId = await prepare(`WhatsApp turns (${suite.module})`, suite.evalSetup);
    rows.push(...(await runCases(agents, userId, typed, scorers, extra, truth)));
  }
  return report(rows);
}
