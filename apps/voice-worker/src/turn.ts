import { type ApiClient, type ChatChunk, createApiClient } from '@app/api-client';
import { VOICE_AGENT_ID, VOICE_ROOM_HEADER } from '@app/contracts';
import type { Lang } from '@app/i18n';
import { config } from './config.js';

/**
 * A tool call from the reply, as the app's chat renders it (an AI SDK UI message part): the
 * worker forwards it to the room, and the app shows it with the views it already has.
 */
export type UiPart = {
  type: `tool-${string}`;
  toolCallId: string;
  state: 'output-available';
  input: unknown;
  output: unknown;
};

export type TurnEvent = { kind: 'text'; text: string } | { kind: 'ui'; part: UiPart };

/** The person this session acts for, the thread its turns go into, and its room (session). */
export type Person = { userId: string; threadId: string; room: string; timeZone?: string };

/** A fresh run id per call: the API ties a turn's audit rows (and its trace) together with it. */
export const newRunId = () => crypto.randomUUID().replaceAll('-', '');

/**
 * The API as this worker sees it: its own key, the person it acts for, and the session (room)
 * it acts in. The API refuses the key anywhere but a turn, and outside an open session.
 */
export function apiFor(person: Person): ApiClient {
  return createApiClient({
    baseUrl: config.apiUrl,
    headers: () => ({
      'x-agent-key': config.agentKey,
      'x-agent-id': VOICE_AGENT_ID,
      'x-acting-for': person.userId,
      [VOICE_ROOM_HEADER]: person.room,
      // Calls outside a turn (the session's end) get a run id of their own.
      'x-run-id': newRunId(),
    }),
  });
}

/** The reply failed on the API's side: the model, or the turn as a whole. */
export class TurnError extends Error {}

/**
 * One spoken turn, as text: it goes to the same /api/chat as a typed one (same agent, rules,
 * approvals and audit; channel voice comes from the worker's key). Yields the reply's text as
 * it streams, to be spoken, and each tool result, for the screen: the app renders them as it
 * does a typed turn's (views, approval cards, the "done" line) and refreshes what they touched.
 * Aborting the signal stops the turn on the API too (a barge-in, a session ending).
 */
export async function* runTurn(
  api: ApiClient,
  person: Person,
  turn: { text: string; lang: Lang },
  signal?: AbortSignal,
): AsyncGenerator<TurnEvent, { runId: string }> {
  const runId = newRunId();
  const inputs = new Map<string, { name: string; input: unknown }>();
  const chunks: AsyncIterable<ChatChunk> = api.chatStream(
    {
      threadId: person.threadId,
      message: turn.text,
      lang: turn.lang,
      surfaces: ['inline', 'canvas', 'speech'],
      timeZone: person.timeZone,
    },
    { 'x-run-id': runId },
    signal,
  );
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta' && typeof chunk.delta === 'string')
      yield { kind: 'text', text: chunk.delta };
    else if (chunk.type === 'error') throw new TurnError(String(chunk.errorText ?? 'turn failed'));
    else if (chunk.type === 'tool-input-available')
      inputs.set(String(chunk.toolCallId), { name: String(chunk.toolName), input: chunk.input });
    else if (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error') {
      const call = inputs.get(String(chunk.toolCallId));
      if (call)
        yield {
          kind: 'ui',
          part: {
            type: `tool-${call.name}`,
            toolCallId: String(chunk.toolCallId),
            state: 'output-available',
            input: call.input,
            // A tool that threw shows as a refusal, with its reason.
            output:
              chunk.type === 'tool-output-error'
                ? { ok: false, error: { reason: String(chunk.errorText ?? 'failed') } }
                : chunk.output,
          },
        };
    }
  }
  return { runId };
}

/** A whole turn at once: what was said, and what was shown (fake mode and tests). */
export async function collectTurn(
  api: ApiClient,
  person: Person,
  turn: { text: string; lang: Lang },
) {
  let spoken = '';
  const uiParts: UiPart[] = [];
  const events = runTurn(api, person, turn);
  let next = await events.next();
  while (!next.done) {
    if (next.value.kind === 'text') spoken += next.value.text;
    else uiParts.push(next.value.part);
    next = await events.next();
  }
  return { spoken: spoken.trim(), uiParts, runId: next.value.runId };
}
