import { Agent } from '@mastra/core/agent';
import { PromptInjectionDetector, UnicodeNormalizer } from '@mastra/core/processors';
import { agentDomain } from './domain/index.js';
import { fakeModel } from './fake/engine.js';
import { platformScripts } from './fake/platform-scripts.js';
import { listBeforeWrite, noRetryAfterRefusal } from './scorers.js';
import { type Profile, toolsFor } from './tools/index.js';
import { AGENT_ID, INSTRUCTIONS, isFakeModel, modelId } from './version.js';

/** Today's date and where the person is, from the chat endpoint's request context. */
function instructions({ requestContext }: { requestContext?: { get(key: string): unknown } }) {
  const timeZone = (requestContext?.get('timeZone') as string | undefined) ?? 'UTC';
  const today =
    (requestContext?.get('today') as string | undefined) ??
    new Date().toLocaleDateString('sv', { timeZone });
  const screen = requestContext?.get('screen') as string | undefined;
  const record = requestContext?.get('record') as { type: string; id: string } | undefined;
  const where = record
    ? `The user is looking at ${record.type} ${record.id}.`
    : screen
      ? `The user is on the ${screen} screen.`
      : '';
  const surfaces = (requestContext?.get('surfaces') as string[] | undefined) ?? ['inline'];
  // The page on the canvas, so "only overdue" can patch the right block (ids and queries).
  const page = (requestContext?.get('canvas') as { page?: unknown } | undefined)?.page;
  return INSTRUCTIONS.replace('{date}', today)
    .replace('{timeZone}', timeZone)
    .replace('{screen}', where)
    .replace('{surfaces}', surfaces.join(', '))
    .replace('{canvas}', page ? ` The canvas shows this page: ${JSON.stringify(page)}` : '');
}

const NAMES: Record<Profile, string> = {
  app: 'Assistant',
  inline: 'Assistant (inline only)',
  text: 'Assistant (text only)',
};

/**
 * One assistant, three tool sets: what it may show depends on where the person is. The
 * app gets the canvas tools; a phone with the canvas closed does not; WhatsApp and voice
 * get words only. The API sees the same agent identity for all three.
 */
export function createAssistant(profile: Profile = 'app'): Agent {
  const fake = isFakeModel();
  return new Agent({
    id: profile === 'app' ? AGENT_ID : `${AGENT_ID}-${profile}`,
    name: NAMES[profile],
    instructions,
    // An openrouter/<provider>/<model> string is all Mastra needs; it reads OPENROUTER_API_KEY.
    // The framework's scripts first (more specific), then the domain's.
    model: fake
      ? fakeModel([...platformScripts, ...agentDomain.scripts], agentDomain.help)
      : modelId(),
    tools: toolsFor(profile),
    // Scored on every turn; results show in Studio when the agent is registered with storage.
    scorers: {
      listBeforeWrite: { scorer: listBeforeWrite, sampling: { type: 'ratio', rate: 1 } },
      noRetryAfterRefusal: { scorer: noRetryAfterRefusal, sampling: { type: 'ratio', rate: 1 } },
    },
    inputProcessors: [
      new UnicodeNormalizer(),
      ...(process.env.GUARDRAILS === 'on' && !fake
        ? [new PromptInjectionDetector({ model: modelId(), strategy: 'block', threshold: 0.8 })]
        : []),
    ],
  });
}
