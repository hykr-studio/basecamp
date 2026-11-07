import type { Principal } from '@hykr/contracts';
import {
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
} from '@hykr/core';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Redirect,
  UseGuards,
} from '@nestjs/common';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import { CalendarService } from './calendar.service.js';
import { InvitesService } from './invites.js';

const uuid = new ParseUUIDPipe();

/**
 * A person's calendars, feeds and free time. Connecting, disconnecting and feeds are the
 * person's own (never the assistant's); busy and free time and a record's invites the assistant
 * reads for them. Sending invites is the `calendar.invite` command.
 */
@Controller('api/calendar')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class CalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly invites: InvitesService,
  ) {}

  @Get('providers')
  providers() {
    return this.calendar.providers();
  }

  @Post('connections')
  @UseGuards(HumanOnlyGuard)
  connect(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.calendar.start(p, body);
  }

  /** The app, back from Google with its code and state: only their starter finishes them. */
  @Post('google/complete')
  @UseGuards(HumanOnlyGuard)
  complete(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    return this.calendar.complete(p, meta.requestId, body);
  }

  @Get('connections')
  @UseGuards(HumanOnlyGuard)
  connections(@CurrentPrincipal() p: Principal) {
    return this.calendar.list(p);
  }

  @Delete('connections/:id')
  @UseGuards(HumanOnlyGuard)
  disconnect(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
  ) {
    return this.calendar.disconnect(p, meta.requestId, id);
  }

  @Get('busy')
  busy(@CurrentPrincipal() p: Principal, @Query() query: Record<string, unknown>) {
    return this.calendar.busy(p, query);
  }

  @Get('free')
  free(@CurrentPrincipal() p: Principal, @Query() query: Record<string, unknown>) {
    return this.calendar.free(p, query);
  }

  @Get('invites')
  async listInvites(
    @CurrentPrincipal() p: Principal,
    @Query() q: { entity?: string; id?: string },
  ) {
    if (!q.entity || !q.id)
      throw new BadRequestException({ error: 'invalid', message: 'Give entity and id' });
    return { items: await this.invites.list(p, q.entity, q.id) };
  }

  @Get('feeds')
  @UseGuards(HumanOnlyGuard)
  feeds(@CurrentPrincipal() p: Principal) {
    return this.calendar.feeds(p);
  }

  @Post('feeds')
  @UseGuards(HumanOnlyGuard)
  createFeed(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    return this.calendar.createFeed(p, meta.requestId, body);
  }

  @Delete('feeds/:id')
  @UseGuards(HumanOnlyGuard)
  revokeFeed(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
  ) {
    return this.calendar.revokeFeed(p, meta.requestId, id);
  }
}

/**
 * What arrives without a session: Google sending the browser back (nothing is exchanged here:
 * the browser goes on to the app, which finishes under its session), and a calendar app reading
 * a feed (the token says whose).
 */
@Controller('api/calendar')
@AllowAnonymous()
export class CalendarPublicController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('google/callback')
  @Redirect()
  async callback(@Query() query: Record<string, unknown>) {
    return { url: await this.calendar.callback(query), statusCode: 302 };
  }

  @Get('feed/:token')
  @Header('content-type', 'text/calendar; charset=utf-8')
  @Header('cache-control', 'private, max-age=300')
  feed(@Param('token') token: string) {
    return this.calendar.renderFeed(token);
  }
}
