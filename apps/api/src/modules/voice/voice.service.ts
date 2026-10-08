import { randomUUID } from 'node:crypto';
import {
  type Principal,
  parseVoiceRoom,
  VOICE_AGENT_ID,
  type VoiceDispatch,
  type VoiceSessionEnd,
  type VoiceSessionRequest,
  type VoiceSessionResponse,
  voiceRoom,
} from '@app/contracts';
import { type Database, writeAudit } from '@app/db';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';
import { ThreadsService, threadOwnerOf } from '../threads/threads.service.js';

/** The start of today in UTC: the day the budget counts. */
const todayUtc = sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;

/**
 * Voice sessions. The API never carries audio: it decides who may talk (a person, within
 * today's budget, in their own thread), hands the app a LiveKit token for one room, and asks
 * LiveKit to dispatch the voice worker into it. The worker then starts each turn at
 * /api/chat as a relay for that person, inside that session, like any other channel.
 *
 * Sessions live in the audit trail: a voice.session.start row per room, and one
 * voice.session.end row when the worker reports it. Nothing else to keep in step.
 */
@Injectable()
export class VoiceService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly threads: ThreadsService,
  ) {}

  async start(p: Principal, input: VoiceSessionRequest): Promise<VoiceSessionResponse> {
    if (!config.voiceAgentKey) throw new ServiceUnavailableException('Voice is not set up here');
    const userId = p.actor.id;
    const limit = config.voiceDailyMinutes * 60;
    const used = await this.secondsToday(userId);
    if (used >= limit)
      throw new HttpException(
        { reason: "You've used today's voice minutes", used, limit },
        HttpStatus.TOO_MANY_REQUESTS,
      );

    const thread = input.threadId
      ? await this.threads.owned(input.threadId, threadOwnerOf(p))
      : await this.threads.current(threadOwnerOf(p));
    // One room per session: LiveKit dispatches the worker when a room is created.
    const room = voiceRoom(userId, thread.id, randomUUID().slice(0, 8));
    const maxSeconds = Math.max(1, Math.min(config.voiceMaxSeconds, limit - used));

    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: userId,
      ttl: '10m',
    });
    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    // Joining creates the room, and the room brings the worker, with the thread and language.
    token.roomConfig = new RoomConfiguration({
      agents: [
        new RoomAgentDispatch({
          agentName: VOICE_AGENT_ID,
          metadata: JSON.stringify({
            threadId: thread.id,
            lang: input.lang,
            timeZone: input.timeZone,
            maxSeconds,
          } satisfies VoiceDispatch),
        }),
      ],
    });

    await writeAudit(this.db, {
      action: 'voice.session.start',
      resourceType: 'thread',
      resourceId: thread.id,
      actorKind: 'user',
      actorId: userId,
      channel: 'voice',
      after: { room, lang: input.lang, maxSeconds },
    });
    return { url: config.livekit.url, token: await token.toJwt(), room, threadId: thread.id };
  }

  /**
   * The session a relay request claims, if it is open: started by this person, not ended, and
   * no older than a session may run. Anything else is not a session the worker may act in.
   */
  async openSession(room: string, userId: string) {
    const named = parseVoiceRoom(room);
    if (named?.userId !== userId) return undefined;
    const { rows } = await this.db.execute<{ open: boolean }>(sql`
      select exists (
        select 1 from audit.events s
        where s.action = 'voice.session.start' and s.actor_id = ${userId}
          and s.after->>'room' = ${room}
          and s.at > now() - make_interval(secs => ${config.voiceMaxSeconds + 120})
          and not exists (
            select 1 from audit.events e
            where e.action = 'voice.session.end' and e.after->>'room' = ${room}
          )
      ) as open`);
    return rows[0]?.open ? named : undefined;
  }

  /** The worker reports a finished session, once: its length counts against the person's day. */
  async end(p: Principal, input: VoiceSessionEnd) {
    const userId = p.actingFor?.userId;
    if (p.actor.kind !== 'agent' || p.actor.id !== VOICE_AGENT_ID || !userId)
      throw new ForbiddenException('Only the voice worker reports sessions');
    const room = await this.openSession(input.room, userId);
    // Already ended (a retry) or not this person's: nothing to record.
    if (!room) return;
    await writeAudit(this.db, {
      action: 'voice.session.end',
      resourceType: 'thread',
      resourceId: room.threadId,
      actorKind: 'agent',
      actorId: VOICE_AGENT_ID,
      actingFor: userId,
      runId: p.runId ?? null,
      channel: 'voice',
      after: { ...input, seconds: Math.min(input.seconds, config.voiceMaxSeconds) },
    });
  }

  /**
   * Seconds spoken today (UTC). A reported session counts what the worker said; one still
   * running (or whose worker never reported) counts the time since it started, up to a
   * session's maximum, so parallel or crashed sessions cannot run past the budget.
   */
  private async secondsToday(userId: string): Promise<number> {
    const { rows } = await this.db.execute<{ seconds: number }>(sql`
      select coalesce(sum(coalesce(
        (select (e.after->>'seconds')::int from audit.events e
          where e.action = 'voice.session.end' and e.after->>'room' = s.after->>'room'
          limit 1),
        least(extract(epoch from now() - s.at)::int, ${config.voiceMaxSeconds})
      )), 0)::int as seconds
      from audit.events s
      where s.action = 'voice.session.start' and s.actor_id = ${userId} and s.at >= ${todayUtc}`);
    return rows[0]?.seconds ?? 0;
  }
}
