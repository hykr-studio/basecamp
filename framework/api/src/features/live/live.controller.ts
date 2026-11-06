import type { Principal } from '@hykr/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@hykr/core';
import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import type { Response } from 'express';
import { LiveHub } from './hub.js';

/**
 * GET /api/live: what changes, as it happens, for the signed-in person (server-sent events).
 * `ready` when it is listening; then a `change` per event about a record they may read
 * ({ name, type, id }, never its fields). It closes after a while: reconnect, and reload what
 * is on screen, since events in between are not replayed.
 */
@Controller('api/live')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class LiveController {
  constructor(private readonly hub: LiveHub) {}

  @Get()
  stream(@CurrentPrincipal() p: Principal, @Res() res: Response): Promise<void> {
    return this.hub.open(p, res);
  }
}
