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

/** One call of a turn: its tool's id, and what it returned (`{ ok, result, present }`). */
export type TurnCall = { tool?: string; output: unknown };

type Output =
  | {
      ok?: unknown;
      result?: unknown;
      present?: { kind?: unknown; props?: unknown; params?: unknown; choices?: unknown };
    }
  | null
  | undefined;

const idOf = (x: unknown): string | undefined => {
  const id = (x as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
};

/** A view a channel shows: a component on a screen, or words where there is none. */
const showsView = (output: unknown) => {
  const kind = (output as Output)?.present?.kind;
  return kind === 'inline' || kind === 'text';
};

/** The records a list read, by id: its rows, and the rows a channel with buttons offers. */
function rowsOf(output: unknown): Set<string> {
  const o = output as Output;
  const items = (o?.result as { items?: unknown } | null | undefined)?.items;
  const choices = o?.present?.choices;
  const ids = [...(Array.isArray(items) ? items : []), ...(Array.isArray(choices) ? choices : [])];
  return new Set(ids.map(idOf).filter((id): id is string => id !== undefined));
}

/**
 * The one record a call that answered showed: its view's record (`props.id`), the screen it
 * opened on the canvas (`params.id`), or, in words, the record it read and showed. A refused call
 * showed nothing.
 */
function recordShown(output: unknown): string | undefined {
  const o = output as Output;
  if (o?.ok !== true || !o.present) return undefined;
  if (o.present.kind === 'open') return idOf(o.present.params);
  if (!showsView(o)) return undefined;
  return idOf(o.present.props) ?? idOf(o.result);
}

const NO_WRITES: ReadonlySet<string> = new Set();

/**
 * Which calls of one turn (in order) only looked something up, so no channel shows them as the
 * answer: not WhatsApp's words, not the app's view, not the saved thread. A lookup is a read whose
 * view (a list, a record, totals) came before
 * - a write in the same turn: the write is what the turn did, whatever it answered (done, waiting,
 *   decided, refused, or its input refused). A call is a write by its tool (`writes`, from
 *   `writeToolIds`), or, for a tool the catalog does not list, by its result (`wroteIn`);
 * - or a later call that showed or opened one of the records it listed ("open Site review": the
 *   meetings, then the meeting): the list was how the assistant found it.
 * A read with neither after it is the answer, and shows: one list, several lists, a list before a
 * refused read. A canvas a call opened is not a view.
 */
export function lookupsIn(
  calls: readonly TurnCall[],
  writes: ReadonlySet<string> = NO_WRITES,
): Set<number> {
  const wrote = calls.map((c) => (c.tool !== undefined && writes.has(c.tool)) || wroteIn(c.output));
  const shown = calls.map((c) => recordShown(c.output));
  const lookups = new Set<number>();
  calls.forEach((c, i) => {
    if (wrote[i] || !showsView(c.output)) return;
    if (wrote.slice(i + 1).some(Boolean)) lookups.add(i);
    else {
      const rows = rowsOf(c.output);
      if (shown.slice(i + 1).some((id) => id !== undefined && rows.has(id))) lookups.add(i);
    }
  });
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
