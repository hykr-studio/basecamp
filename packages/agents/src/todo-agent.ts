import { Agent } from '@mastra/core/agent';
import { PromptInjectionDetector, UnicodeNormalizer } from '@mastra/core/processors';
import { fakeModel } from './fake-model.js';
import { listBeforeWrite, noRetryAfterRefusal } from './scorers.js';
import { tools } from './tools/index.js';
import { AGENT_ID, INSTRUCTIONS, isFakeModel, modelId } from './version.js';

/** Today's date and where the person is, from the chat endpoint's request context. */
function instructions({ requestContext }: { requestContext?: { get(key: string): unknown } }) {
  const today =
    (requestContext?.get('today') as string | undefined) ?? new Date().toISOString().slice(0, 10);
  const screen = requestContext?.get('screen') as string | undefined;
  const meetingId = requestContext?.get('meetingId') as string | undefined;
  const where = meetingId
    ? `The user is looking at meeting ${meetingId}.`
    : screen
      ? `The user is on the ${screen} screen.`
      : '';
  return INSTRUCTIONS.replace('{date}', today).replace('{screen}', where);
}

export function createTodoAgent(): Agent {
  const fake = isFakeModel();
  return new Agent({
    id: AGENT_ID,
    name: 'Meetings assistant',
    instructions,
    // An openrouter/<provider>/<model> string is all Mastra needs; it reads OPENROUTER_API_KEY.
    model: fake ? fakeModel() : modelId(),
    tools,
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
