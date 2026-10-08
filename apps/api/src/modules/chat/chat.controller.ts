import { ChatRequest, type ChatResponse, ChatStreamRequest, type Principal } from '@app/contracts';
import { ChatAccessGuard, CurrentPrincipal, PrincipalGuard, RelayAllowed } from '@app/core';
import { toAISdkStream } from '@mastra/ai-sdk';
import { Body, Controller, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { VoiceSessionGuard } from '../voice/voice-session.guard.js';
import { ChatService } from './chat.service.js';

class ChatDto extends createZodDto(ChatRequest) {}
class ChatStreamDto extends createZodDto(ChatStreamRequest) {}

/**
 * A chat turn, from a person or from a relay acting for one (the voice worker). The message
 * goes into a thread the server keeps; the history comes from it, never from the client.
 */
@Controller('api/chat')
@OptionalAuth()
@RelayAllowed()
@UseGuards(PrincipalGuard, ChatAccessGuard, VoiceSessionGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /**
   * The app's chat (and the voice worker's): an AI SDK UI message stream. Tool results arrive
   * as they happen, each carrying its present intent; the client renders them with the views
   * it registered. `@Res()` means this handler owns the response, so nothing else writes to it.
   */
  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // each call costs model tokens
  async stream(
    @CurrentPrincipal() p: Principal,
    @Body() body: ChatStreamDto,
    @Res() res: Response,
  ): Promise<void> {
    // Stop the agent if the person leaves mid-turn: no tokens spent on a closed tab.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    // Voice turns draw on screen and speak; the app's own turns say where they can draw.
    const surfaces =
      p.channel === 'voice' ? (['inline', 'canvas', 'speech'] as const) : body.surfaces;
    const { output, runId, threadId, saved } = await this.chat.stream(
      p,
      { ...body, surfaces: [...surfaces] },
      abort.signal,
    );
    pipeUIMessageStreamToResponse({
      response: res,
      // The run and thread ride on the message: the Studio link, and where the turn was saved.
      // The response ends once the reply is saved, so a reload right after sees it.
      stream: createUIMessageStream({
        execute: async ({ writer }) => {
          writer.merge(
            toAISdkStream(output, {
              from: 'agent',
              version: 'v7',
              messageMetadata: () => ({ runId, threadId }),
            }),
          );
          await saved;
        },
      }),
      // No compression on this route: buffered or gzipped chunks stall streaming on native.
      headers: {
        'x-run-id': runId,
        'x-thread-id': threadId,
        'cache-control': 'no-cache, no-transform',
      },
    });
  }

  /** The same turn as one JSON answer: the e2e tests and channels that cannot stream. */
  @Post('once')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  once(@CurrentPrincipal() p: Principal, @Body() body: ChatDto): Promise<ChatResponse> {
    return this.chat.once(p, body);
  }
}
