import { t } from '@app/i18n';
import { type JobContext, log } from '@livekit/agents';
import { CHAT_TOPIC, onText, type Session, setState, TRANSCRIPTION_TOPIC } from './room.js';
import { runTurn } from './turn.js';

/**
 * VOICE_MODE=fake: the whole session with no audio models. The person's words arrive as text
 * on lk.chat (typed, or transcribed by their device); the reply goes out as the transcript
 * the live worker would speak, and its tool parts to the screen. Everything between is the
 * real path.
 */
export function runFake(ctx: JobContext, session: Session) {
  const room = ctx.room;
  const logger = log().child({ room: room.name, mode: 'fake' });
  let queue = Promise.resolve();

  onText(ctx, CHAT_TOPIC, session.person.userId, (text) => {
    if (!text) return;
    // One turn at a time, in the order they were said.
    queue = queue.then(() => turn(text));
  });

  async function turn(text: string) {
    session.heard();
    session.turns += 1;
    const lang = session.lang.hear(text);
    const started = Date.now();
    let spoken = '';
    try {
      await setState(ctx, 'thinking');
      for await (const event of runTurn(
        session.api,
        session.person,
        { text, lang },
        session.ended,
      )) {
        if (event.kind === 'text') spoken += event.text;
        else await session.show(event.part);
      }
      logger.info({ lang, ms: Date.now() - started }, 'turn');
    } catch (e) {
      if (session.ended.aborted) return;
      logger.error({ err: e }, 'turn failed');
      spoken = t(lang, 'said.failed');
    }
    try {
      await setState(ctx, 'speaking');
      await room.localParticipant?.sendText(spoken.trim() || t(lang, 'said.failed'), {
        topic: TRANSCRIPTION_TOPIC,
        attributes: { 'lk.transcription_final': 'true', 'lk.segment_id': crypto.randomUUID() },
      });
    } finally {
      await setState(ctx, 'listening').catch(() => {});
    }
  }
  return setState(ctx, 'listening');
}
