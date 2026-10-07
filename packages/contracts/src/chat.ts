import { z } from 'zod';

export const ChatRole = z.enum(['user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string().min(1).max(20_000),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** Where the person is, so "close this one" and pasted notes need no meeting name. */
export const ChatContext = z.object({
  screen: z.enum(['today', 'meetings', 'meeting', 'notes', 'todos']),
  meetingId: z.uuid().optional(),
});
export type ChatContext = z.infer<typeof ChatContext>;

export const ChatRequest = z.object({
  messages: z.array(ChatMessage).min(1).max(40),
  context: ChatContext.optional(),
  /** The person's IANA time zone (e.g. Asia/Kolkata), so the assistant states local times. */
  timeZone: z.string().min(1).max(64).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/**
 * What one tool call amounted to. "ok" only says the API answered; the outcome says
 * whether the work happened, is waiting for the person, or was refused.
 */
export const ToolCallSummary = z.object({
  tool: z.string(),
  ok: z.boolean(),
  outcome: z.enum(['done', 'parked', 'refused']),
  /** The approval summary when parked; the reason when refused. */
  detail: z.string().optional(),
});
export type ToolCallSummary = z.infer<typeof ToolCallSummary>;

/** One agent turn: its reply, the run id that ties its audit rows together, and what it called. */
export const ChatResponse = z.object({
  reply: z.string(),
  runId: z.string(),
  toolCalls: z.array(ToolCallSummary),
});
export type ChatResponse = z.infer<typeof ChatResponse>;
