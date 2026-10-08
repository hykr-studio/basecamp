import { VOICE_ROOM_HEADER } from '@app/contracts';
import { type ApiRequest, CORE_OPTIONS, type CoreOptions, header } from '@app/core';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { VoiceService } from './voice.service.js';

/**
 * A relay (the voice worker) acts only inside an open voice session of the person it acts for,
 * named by its room. Its turns go to that session's thread. People pass straight through.
 * Use after PrincipalGuard, on routes marked @RelayAllowed().
 */
@Injectable()
export class VoiceSessionGuard implements CanActivate {
  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    private readonly voice: VoiceService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const p = req.principal;
    const relay = this.options.agents.find((a) => a.id === p?.actor.id)?.relay;
    if (p?.actor.kind !== 'agent' || !relay) return true;
    const room = header(req, VOICE_ROOM_HEADER);
    const userId = p.actingFor?.userId;
    const session = room && userId ? await this.voice.openSession(room, userId) : undefined;
    if (!session) throw new ForbiddenException('No open voice session for this person');
    // A turn goes into the session's thread, whatever the body says.
    const body = req.body as { threadId?: string } | undefined;
    if (body && typeof body === 'object') {
      if (body.threadId && body.threadId !== session.threadId)
        throw new ForbiddenException('That thread is not this session’s');
      body.threadId = session.threadId;
    }
    return true;
  }
}
