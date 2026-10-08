import { z } from 'zod';
import { commandSpec } from '../framework/spec.js';

export const RequestHumanInput = z.object({
  reason: z.string().min(1).max(200).describe('Why a person should take over, in a few words'),
});

/**
 * Hand a WhatsApp conversation to a person from the business. Until staff hand it back the
 * assistant stays silent there; the person's messages wait in the back office.
 */
export const RequestHumanSpec = commandSpec({
  name: 'handoff.request',
  description:
    'Hand this WhatsApp conversation to a person from the business: when the user asks for a person, is upset, or needs something you cannot do. Afterwards say that someone from the team will reply here, and do nothing else in this conversation.',
  input: RequestHumanInput,
  output: z.object({ opened: z.boolean() }),
  http: { method: 'POST', path: '/api/handoff' },
  tool: 'request-human',
  expose: 'all',
  verb: { do: 'hand over', did: 'handed over' },
  touches: [],
});
