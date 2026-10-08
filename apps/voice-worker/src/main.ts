import { fileURLToPath } from 'node:url';
import { VOICE_AGENT_ID } from '@app/contracts';
import {
  cli,
  defineAgent,
  type JobContext,
  type JobProcess,
  ServerOptions,
  type VAD,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { assertConfig, config } from './config.js';
import { runFake } from './fake.js';
import { runLive } from './live.js';
import { openSession } from './room.js';

/**
 * The voice worker: another way into the same assistant. LiveKit dispatches it into a room
 * the API created for one person and one thread; it turns speech into text, starts each turn
 * at /api/chat as that person's relay, speaks the short answer and forwards what the reply
 * shows. It holds no rules, tools or data of its own.
 */
export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    if (config.mode === 'live') proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const session = await openSession(ctx);
    if (!session) return ctx.shutdown('not a voice room');
    if (config.mode === 'fake') await runFake(ctx, session);
    else await runLive(ctx, session, ctx.proc.userData.vad as VAD);
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertConfig();
  cli.runApp(
    new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: VOICE_AGENT_ID }),
  );
}
