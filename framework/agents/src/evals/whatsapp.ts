// WhatsApp turns: words only (surfaces ['text'], channel whatsapp), the business-only rule, and
// the language the person writes in. Scored on the right tools and the reply's language.
// `basecamp eval whatsapp` (scripted model) or `basecamp eval whatsapp --live`.
//
// The framework's own cases, then the application's Hindi and Telugu turns typed instead of
// said. Needs the API running.
import type { Surface } from '@hykr/contracts';
import type { Lang } from '@hykr/i18n';
import type { EvalCase } from '../agent-domain.js';
import type { Agents } from '../agents.js';
import { expectedOutcome, listBeforeWrite, repliesInLanguage } from '../scorers.js';
import { prepare, report, runCases } from './harness.js';

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

export async function evalWhatsapp(agents: Agents): Promise<boolean> {
  const typed: WhatsAppCase[] = (agents.domain.voiceEvalCases ?? [])
    .filter((c) => c.lang !== 'en')
    .map((c) => ({ ...c, why: `${c.why}, typed on WhatsApp`, surfaces: TEXT }));
  const userId = await prepare(agents, 'WhatsApp turns');
  return report(
    await runCases(
      agents,
      userId,
      [...framework(agents).map((c) => ({ ...c, surfaces: TEXT })), ...typed],
      [expectedOutcome, listBeforeWrite(agents.catalog.commands), repliesInLanguage],
      (c, ctx) => {
        ctx.set('lang', c.lang);
        ctx.set('channel', 'whatsapp');
      },
      (c) => ({ ...c.expect, lang: c.lang }),
    ),
  );
}
