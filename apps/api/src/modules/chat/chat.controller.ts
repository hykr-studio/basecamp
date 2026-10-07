import { randomUUID } from 'node:crypto';
import { createTodoAgent } from '@app/agents';
import { ChatRequest, type ChatResponse, type Principal } from '@app/contracts';
import { RequestContext } from '@mastra/core/request-context';
import {
  Body,
  Controller,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { createZodDto } from 'nestjs-zod';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '../../common/principal.js';

class ChatDto extends createZodDto(ChatRequest) {}

const agent = createTodoAgent();

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
    const runId = randomUUID();
    const requestContext = new RequestContext();
    requestContext.set('userId', p.actor.id);
    requestContext.set('runId', runId);

    // Literal roles: Mastra's generate() type rejects a plain 'user' | 'assistant' union.
    const messages = body.messages.map((m) =>
      m.role === 'user'
        ? { role: 'user' as const, content: m.content }
        : { role: 'assistant' as const, content: m.content },
    );
    const result = await agent.generate(messages, { requestContext, maxSteps: 8 });

    const toolCalls = (result.toolResults ?? []).map((r) => {
      const x = ('payload' in r ? r.payload : r) as {
        toolName?: string;
        result?: { ok?: boolean };
      };
      return { tool: String(x.toolName ?? 'tool'), ok: x.result?.ok !== false };
    });
    return { reply: result.text, runId, toolCalls };
  }
}
