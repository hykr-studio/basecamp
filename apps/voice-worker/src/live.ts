import { ReadableStream } from 'node:stream/web';
import { t } from '@app/i18n';
import type { VAD } from '@livekit/agents';
import { type JobContext, llm, log, voice } from '@livekit/agents';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import type { Session } from './room.js';
import { runTurn } from './turn.js';

/**
 * The Bulbul voice for each language. One voice speaks all three today; give a language its
 * own speaker here (any bulbul:v3 speaker) and switches between languages are heard too.
 */
const SPEAKER = { en: 'shubh', hi: 'shubh', te: 'shubh' } as const;

/**
 * The session needs an LLM to take turns at all; this one never runs, because ApiAgent's
 * llmNode answers every turn from the API instead.
 */
class ApiRelay extends llm.LLM {
  label() {
    return 'api-relay';
  }
  chat(): llm.LLMStream {
    throw new Error('ApiAgent.llmNode answers turns; the relay LLM is never called');
  }
}

/**
 * The agent the session talks to. Its "model" is the product's own /api/chat: each finished
 * utterance goes there as the person's relay, the text that streams back is spoken, and the
 * tool parts go to the screen. No instructions or tools live here; they are the API's.
 */
class ApiAgent extends voice.Agent {
  /** The last words speech-to-text heard; a turn with other words was typed. */
  lastHeard = '';

  constructor(private readonly s: Session) {
    super({ instructions: 'Relay: the API answers.' });
  }

  async llmNode(chatCtx: llm.ChatContext): Promise<ReadableStream<string>> {
    const said = chatCtx.items.findLast(
      (i): i is llm.ChatMessage => i.type === 'message' && i.role === 'user',
    );
    const text = said?.textContent?.trim() ?? '';
    const s = this.s;
    // A typed line (lk.chat) arrives without a transcript: it counts as speech too.
    if (text !== this.lastHeard) {
      s.heard();
      s.lang.hear(text);
    }
    s.turns += 1;
    const lang = s.lang.lang;
    const started = Date.now();
    // Interrupted (the person spoke over it) or the session ended: stop the turn on the API.
    const abort = new AbortController();
    s.ended.addEventListener('abort', () => abort.abort(), { once: true });
    let open = true;
    return new ReadableStream<string>({
      async start(controller) {
        let first = true;
        try {
          for await (const event of runTurn(s.api, s.person, { text, lang }, abort.signal)) {
            if (!open) break;
            if (event.kind === 'ui') await s.show(event.part);
            else {
              if (first) log().info({ lang, ms: Date.now() - started }, 'first words');
              first = false;
              controller.enqueue(event.text);
            }
          }
        } catch (e) {
          if (open && !abort.signal.aborted) {
            log().error({ err: e }, 'turn failed');
            controller.enqueue(t(lang, 'said.failed'));
          }
        } finally {
          if (open) {
            open = false;
            controller.close();
          }
        }
      },
      cancel() {
        open = false;
        abort.abort();
      },
    });
  }
}

/** VOICE_MODE=live: Sarvam hears and speaks; VAD ends turns, and the person can barge in. */
export async function runLive(ctx: JobContext, session: Session, vad: VAD) {
  // Speech-to-text's language is set once (its stream keeps it): detect, or the pinned one.
  const stt = new sarvam.STT({ model: 'saaras:v3', languageCode: session.lang.sttLanguage });
  const tts = new sarvam.TTS({
    model: 'bulbul:v3',
    targetLanguageCode: session.lang.ttsLanguage,
    speaker: SPEAKER[session.lang.lang],
  });
  const agentSession = new voice.AgentSession({
    vad,
    stt,
    tts,
    llm: new ApiRelay(),
    turnHandling: {
      turnDetection: 'vad',
      interruption: { enabled: true },
      // Every llmNode call is a real turn on the API (it can write): never run one on a guess.
      preemptiveGeneration: { enabled: false },
    },
  });
  const agent = new ApiAgent(session);

  // The voice follows the language: each reply is spoken in the one it is written in.
  const voiceFollows = () =>
    tts.updateOptions({
      targetLanguageCode: session.lang.ttsLanguage,
      speaker: SPEAKER[session.lang.lang],
    });
  session.onLangChange = voiceFollows;

  agentSession.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (!ev.isFinal) return;
    session.heard();
    agent.lastHeard = ev.transcript.trim();
    const before = session.lang.lang;
    if (session.lang.hear(ev.transcript, ev.language ?? undefined) !== before) voiceFollows();
  });

  await agentSession.start({
    agent,
    room: ctx.room,
    inputOptions: { participantIdentity: session.person.userId },
  });
}
