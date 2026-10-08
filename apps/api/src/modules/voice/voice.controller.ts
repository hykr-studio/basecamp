import {
  type Principal,
  VoiceSessionEnd,
  VoiceSessionRequest,
  type VoiceSessionResponse,
} from '@app/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard, RelayAllowed } from '@app/core';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { createZodDto } from 'nestjs-zod';
import { VoiceService } from './voice.service.js';

class SessionDto extends createZodDto(VoiceSessionRequest) {}
class EndDto extends createZodDto(VoiceSessionEnd) {}

@Controller('api/voice')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /** A person starts talking: a token for their room, with the voice worker dispatched to it. */
  @Post('session')
  @UseGuards(HumanOnlyGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  session(
    @CurrentPrincipal() p: Principal,
    @Body() body: SessionDto,
  ): Promise<VoiceSessionResponse> {
    return this.voice.start(p, body);
  }

  /** The voice worker, when a session ends (the service checks it is the worker, and once). */
  @Post('end')
  @RelayAllowed()
  @HttpCode(204)
  async end(@CurrentPrincipal() p: Principal, @Body() body: EndDto): Promise<void> {
    await this.voice.end(p, body);
  }
}
