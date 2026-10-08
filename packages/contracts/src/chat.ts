import { z } from 'zod';
import { PageSpec, Present, Surfaces } from './framework/present.js';
import { Channel, Lang } from './voice.js';

export const ChatRole = z.enum(['user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string().min(1).max(20_000),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/**
 * Where the person is, so "close this one" needs no name: the screen (a hint, as the app
 * names it) and the record it shows. Tools still load records through the owner scope, so a
 * forged id finds nothing.
 */
export const ChatContext = z.object({
  screen: z.string().max(40).optional(),
  record: z.object({ type: z.string().max(40), id: z.uuid() }).optional(),
  /** What the canvas shows now, so "only overdue ones" patches it and "save this" saves it. */
  canvas: z.object({ page: PageSpec, pageId: z.uuid().optional() }).optional(),
});
export type ChatContext = z.infer<typeof ChatContext>;

/**
 * One turn: the person's new message, in a thread the server keeps. History comes from the
 * thread, never from the client, so typed and spoken turns share one conversation.
 */
const TurnFields = {
  /** The thread to continue; omitted, the person's current thread. */
  threadId: z.uuid().optional(),
  message: z.string().trim().min(1).max(20_000),
  /** The language to answer in; omitted, the assistant follows the person's. */
  lang: Lang.optional(),
};

export const ChatRequest = z.object({
  ...TurnFields,
  context: ChatContext.optional(),
  /** The person's IANA time zone (e.g. Asia/Kolkata), so the assistant states local times. */
  timeZone: z.string().min(1).max(64).optional(),
  /** Where this turn can show things. A plain JSON caller draws nothing: text by default. */
  surfaces: Surfaces.default(['text']),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/** The streaming chat request (POST /api/chat): the same turn, answered as a stream. */
export const ChatStreamRequest = z.object({
  ...TurnFields,
  context: ChatContext.optional(),
  timeZone: z.string().min(1).max(64).optional(),
  surfaces: Surfaces.default(['inline']),
});
export type ChatStreamRequest = z.infer<typeof ChatStreamRequest>;

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
  /** When parked: the approval, so the chat can show what became of it. */
  approvalId: z.string().optional(),
  /** What the result shows, resolved for the turn's surfaces. */
  present: Present.optional(),
  /** On a spoken turn with a screen: the short form, in the turn's language. */
  speech: z.string().optional(),
});
export type ToolCallSummary = z.infer<typeof ToolCallSummary>;

/** One agent turn: its reply, the run id that ties its audit rows together, and what it called. */
export const ChatResponse = z.object({
  reply: z.string(),
  runId: z.string(),
  threadId: z.uuid(),
  toolCalls: z.array(ToolCallSummary),
});
export type ChatResponse = z.infer<typeof ChatResponse>;

/** One line of a record's history, from the audit trail. */
export const HistoryEntry = z.object({
  at: z.iso.datetime(),
  action: z.string(),
  actor: z.enum(['you', 'assistant']),
  /** The person approved what the assistant asked for. */
  approvedByYou: z.boolean(),
  outcome: z.enum(['committed', 'denied', 'needs_approval']),
  reason: z.string().nullable(),
  runId: z.string().nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** A conversation the server keeps for one person: typed, spoken and WhatsApp turns. */
export const Thread = z.object({
  id: z.uuid(),
  title: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Thread = z.infer<typeof Thread>;

/**
 * A saved message, in the AI SDK's UI message shape so the app renders it as it streamed:
 * a text part, and for replies each tool call with its output (and present intent).
 */
export const ThreadMessage = z.object({
  id: z.string(),
  role: ChatRole,
  parts: z.array(z.looseObject({ type: z.string() })),
  metadata: z.object({
    runId: z.string().nullable(),
    channel: Channel,
    lang: Lang.nullable(),
    createdAt: z.iso.datetime(),
  }),
});
export type ThreadMessage = z.infer<typeof ThreadMessage>;
