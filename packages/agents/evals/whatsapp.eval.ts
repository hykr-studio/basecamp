// WhatsApp turns: words only (surfaces ['text'], channel whatsapp), the business-only rule, and
// the language the person writes in. Scored on the right tools and the reply's language.
//
//   pnpm --filter @app/agents eval:whatsapp        scripted model (CI)
//   pnpm --filter @app/agents eval:whatsapp:live   your AGENT_MODEL
//
// The framework's own cases, then the domain's Hindi and Telugu turns typed instead of said.
// Needs the API running. Exits 1 if any turn misses.
import type { Surface } from '@app/contracts';
import type { Lang } from '@app/i18n';
import type { EvalCase } from '../src/agent-domain.js';
import { agentDomain } from '../src/domain/index.js';
import { expectedOutcome, listBeforeWrite, repliesInLanguage } from '../src/scorers.js';
import { prepare, report, runCases } from './harness.js';

const TEXT: Surface[] = ['text'];
const NO_SCREEN = ['canvas', 'screen', 'tap '];
type WhatsAppCase = EvalCase & { lang: Lang };

const framework: WhatsAppCase[] = [
  {
    lang: 'en',
    why: 'off-topic: no business tool, no essay',
    input: 'write me a poem about cricket',
    expect: {
      must: [],
      mustNot: ['create-todo', 'create-note', 'send-template', 'request-human'],
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

const typed: WhatsAppCase[] = (agentDomain.voiceEvalCases ?? [])
  .filter((c) => c.lang !== 'en')
  .map((c) => ({ ...c, why: `${c.why}, typed on WhatsApp`, surfaces: TEXT }));

const userId = await prepare('WhatsApp turns');
report(
  await runCases(
    userId,
    [...framework.map((c) => ({ ...c, surfaces: TEXT })), ...typed],
    [expectedOutcome, listBeforeWrite, repliesInLanguage],
    (c, ctx) => {
      ctx.set('lang', c.lang);
      ctx.set('channel', 'whatsapp');
    },
    (c) => ({ ...c.expect, lang: c.lang }),
  ),
);
