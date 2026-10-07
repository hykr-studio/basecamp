import { randomUUID } from 'node:crypto';
import { mastra } from '@app/agents';
import {
  ChatRequest,
  type ChatResponse,
  type Principal,
  type ToolCallSummary,
} from '@app/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@app/core';
import { RequestContext } from '@mastra/core/request-context';
import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { createZodDto } from 'nestjs-zod';

class ChatDto extends createZodDto(ChatRequest) {}

function validTimeZone(zone: string | undefined): string {
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

// The shared Mastra instance: runs are traced and scored, and show up in Studio.
const agent = mastra.getAgent('todoAgent');
const log = new Logger('Chat');

/**
 * A person sends messages; the agent runs one turn acting for that person. Its tool
 * calls go back through the API under its own key, so every rule and audit row applies.
 */
@Controller('api/chat')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class ChatController {
  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // each call costs model tokens
  async chat(@CurrentPrincipal() p: Principal, @Body() body: ChatDto): Promise<ChatResponse> {
    if (process.env.MODEL_MODE !== 'fake' && !process.env.OPENROUTER_API_KEY) {
      throw new ServiceUnavailableException('Set OPENROUTER_API_KEY in .env to use the assistant');
    }

    // Who the agent acts for comes from the server-side principal, never the request
    // body: the model cannot choose whose to-dos it touches.
    // The run id doubles as the trace id (32 hex chars), so an audit row's run_id
    // opens the matching trace in Studio.
    const runId = randomUUID().replaceAll('-', '');
    const requestContext = new RequestContext();
    requestContext.set('userId', p.actor.id);
    requestContext.set('runId', runId);
    // Times and "today" in the person's own time zone (an invalid zone falls back to UTC).
    const timeZone = validTimeZone(body.timeZone);
    requestContext.set('timeZone', timeZone);
    requestContext.set('today', new Date().toLocaleDateString('sv', { timeZone }));
    // Where the person is: a hint only. Tools still load the meeting through the owner scope,
    // so a forged id finds nothing.
    if (body.context) {
      requestContext.set('screen', body.context.screen);
      if (body.context.meetingId) requestContext.set('meetingId', body.context.meetingId);
    }

    // Literal roles: Mastra's generate() type rejects a plain 'user' | 'assistant' union.
    const messages = body.messages.map((m) =>
      m.role === 'user'
        ? { role: 'user' as const, content: m.content }
        : { role: 'assistant' as const, content: m.content },
    );
    const started = Date.now();
    const result = await agent.generate(messages, {
      requestContext,
      maxSteps: 8,
      tracingOptions: { traceId: runId, metadata: { userId: p.actor.id } },
    });

    // "ok" only means the API answered; the outcome says whether the work happened.
    const toolCalls: ToolCallSummary[] = (result.toolResults ?? []).map((r) => {
      const x = ('payload' in r ? r.payload : r) as {
        toolName?: string;
        result?: {
          ok?: boolean;
          result?: { status?: string; approval?: { id?: string; summary?: string | null } };
          error?: { reason?: string; message?: unknown } | null;
        };
      };
      const tool = String(x.toolName ?? 'tool');
      if (x.result?.ok === false) {
        const reason = x.result.error?.reason ?? x.result.error?.message;
        return {
          tool,
          ok: false,
          outcome: 'refused',
          ...(typeof reason === 'string' ? { detail: reason } : {}),
        };
      }
      if (x.result?.result?.status === 'needs_approval') {
        const { summary, id } = x.result.result.approval ?? {};
        return {
          tool,
          ok: true,
          outcome: 'parked',
          ...(summary ? { detail: summary } : {}),
          ...(id ? { approvalId: id } : {}),
        };
      }
      return { tool, ok: true, outcome: 'done' };
    });
    // One summary line per turn: in this terminal, and in Studio → Logs (run = trace id).
    mastra.loggerVNext.info('chat turn', {
      runId,
      userId: p.actor.id,
      tools: toolCalls,
      tokens: result.totalUsage?.totalTokens,
      ms: Date.now() - started,
    });
    log.log(
      `run=${runId} user=${p.actor.id} tools=[${toolCalls
        .map((c) => `${c.tool}:${c.outcome}`)
        .join(',')}] tokens=${result.totalUsage?.totalTokens ?? '?'} ${Date.now() - started}ms`,
    );
    return { reply: result.text, runId, toolCalls };
  }
}
