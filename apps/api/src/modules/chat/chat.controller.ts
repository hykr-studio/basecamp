import {
  ChatRequest,
  type ChatResponse,
  ChatStreamRequest,
  type Principal,
  type StreamMessage,
} from '@app/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@app/core';
import { toAISdkStream } from '@mastra/ai-sdk';
import { Body, Controller, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { pipeUIMessageStreamToResponse } from 'ai';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { ChatService } from './chat.service.js';

class ChatDto extends createZodDto(ChatRequest) {}
class ChatStreamDto extends createZodDto(ChatStreamRequest) {}

/**
 * The text of each message, as the agent reads history. Tool parts are not replayed: the
 * canvas travels in the context instead, and the client cannot add tools or instructions
 * (anything but text parts is ignored).
 */
function textOf(messages: StreamMessage[]) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('\n')
        .trim(),
    }))
    .filter((m) => m.content);
}

@Controller('api/chat')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /**
   * The app's chat: an AI SDK UI message stream. Tool results arrive as they happen, each
   * carrying its present intent; the client renders them with the views it registered.
   * `@Res()` means this handler owns the response, so nothing else writes to it.
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
    const { output, runId } = await this.chat.stream(
      p,
      {
        messages: textOf(body.messages),
        context: body.context,
        timeZone: body.timeZone,
        surfaces: body.surfaces,
      },
      abort.signal,
    );
    pipeUIMessageStreamToResponse({
      response: res,
      // The run id rides on the message, so the chat can link the trace in Studio.
      stream: toAISdkStream(output, {
        from: 'agent',
        version: 'v7',
        messageMetadata: () => ({ runId }),
      }),
      // No compression on this route: buffered or gzipped chunks stall streaming on native.
      headers: { 'x-run-id': runId, 'cache-control': 'no-cache, no-transform' },
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
