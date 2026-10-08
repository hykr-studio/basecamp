import type { VoiceLang } from '@app/contracts';
import { LangState } from './lang.js';
import { apiFor, collectTurn, type Person } from './turn.js';

/**
 * One utterance through the whole voice path except audio: the language decision, the turn
 * at /api/chat as the person's relay inside their session, and what would be spoken and
 * shown. Tests call it with a session the API opened and no room at all.
 */
export async function say(input: {
  person: Person;
  text: string;
  /** The session's language: a pin, or auto. Ignored when `state` carries one already. */
  lang?: VoiceLang;
  state?: LangState;
}) {
  const state = input.state ?? new LangState(input.lang);
  const lang = state.hear(input.text);
  const turn = await collectTurn(apiFor(input.person), input.person, { text: input.text, lang });
  return { ...turn, lang };
}
