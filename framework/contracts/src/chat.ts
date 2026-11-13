import { z } from 'zod';
import { PageSpec, Present, Surfaces } from './framework/present.js';
import { Lang, LangCode } from './languages.js';
import { Channel } from './voice.js';

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

/** How a resumed call's request was decided (a durable run's write, @hykr/core tools). */
const DECIDED = new Set(['approved', 'rejected', 'expired', 'failed']);

/**
 * Whether a tool's output (`{ ok, result, present }`, as the agent got it) is a write's: done,
 * with its value; waiting for an approval; or, in a run that waited, how its request was decided.
 * A read's record can carry a `status` of its own ('approved', 'done'), so the shape decides.
 */
export function wroteIn(output: unknown): boolean {
  const r = (output as { result?: unknown } | null | undefined)?.result;
  if (!r || typeof r !== 'object') return false;
  const { status } = r as { status?: unknown };
  if (status === 'done') return 'value' in r && !('id' in r);
  if (status === 'needs_approval' || (typeof status === 'string' && DECIDED.has(status))) {
    const { approval } = r as { approval?: unknown };
    return !!approval && typeof approval === 'object' && !('id' in r);
  }
  return false;
}

/** A view a channel shows: a component on a screen, or words where there is none. */
const showsView = (output: unknown) => {
  const kind = (output as { present?: { kind?: unknown } } | null | undefined)?.present?.kind;
  return kind === 'inline' || kind === 'text';
};

/**
 * Which calls of one turn (their outputs, in order) only looked something up: a read whose view
 * (a list, a record, totals) came before a later write in the same turn. The write is what the
 * turn did; the read was how the assistant found what to write, so no channel shows it as the
 * answer: not WhatsApp's words, not the app's view, not the saved thread. A read with no write
 * after it is the answer, and shows. A refusal is no write here (it may be a read's), and a
 * canvas a call opened is not a view.
 */
export function lookupsIn(outputs: readonly unknown[]): Set<number> {
  const lookups = new Set<number>();
  let wroteAfter = false;
  for (let i = outputs.length - 1; i >= 0; i--) {
    if (wroteIn(outputs[i])) wroteAfter = true;
    else if (wroteAfter && showsView(outputs[i])) lookups.add(i);
  }
  return lookups;
}

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
  /** Which record, and its name: set on every line, needed by a feed across records. */
  resourceType: z.string().optional(),
  resourceId: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  /** A state change on this line: the state field's value before and after. */
  transition: z.object({ from: z.string().nullable(), to: z.string() }).nullable().optional(),
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
    lang: LangCode.nullable(),
    createdAt: z.iso.datetime(),
  }),
});
export type ThreadMessage = z.infer<typeof ThreadMessage>;
