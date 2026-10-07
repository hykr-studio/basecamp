import { z } from 'zod';

const title = z.string().min(1).max(200);
const dueOn = z.iso.date();

export const Todo = z.object({
  id: z.string(),
  title,
  done: z.boolean(),
  dueOn: dueOn.nullable(),
});
export type Todo = z.infer<typeof Todo>;

export const CreateTodoInput = z.object({
  title,
  dueOn: dueOn.optional(),
});
export type CreateTodoInput = z.infer<typeof CreateTodoInput>;

export const UpdateTodoInput = z
  .object({
    title: title.optional(),
    done: z.boolean().optional(),
    dueOn: dueOn.optional(),
  })
  .refine(
    (value) => value.title !== undefined || value.done !== undefined || value.dueOn !== undefined,
    'At least one of title, done, or dueOn is required',
  );
export type UpdateTodoInput = z.infer<typeof UpdateTodoInput>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const Approval = z.object({
  id: z.string(),
  action: z.string(),
  rule: z.string(),
  reason: z.string(),
  status: ApprovalStatus,
  /** What the person is being asked to approve, e.g. Delete "Buy cement". */
  summary: z.string().nullable(),
  expiresAt: z.iso.datetime(),
});
export type Approval = z.infer<typeof Approval>;

export const WriteResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done'), todo: Todo.nullable() }),
  z.object({ status: z.literal('needs_approval'), approval: Approval }),
]);
export type WriteResult = z.infer<typeof WriteResult>;

export const ChatRole = z.enum(['user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string().min(1),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatRequest = z.object({
  messages: z.array(ChatMessage).min(1),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export const ToolCallSummary = z.object({ tool: z.string(), ok: z.boolean() });
export type ToolCallSummary = z.infer<typeof ToolCallSummary>;

/** One agent turn: its reply, the run id that ties its audit rows together, and what it called. */
export const ChatResponse = z.object({
  reply: z.string(),
  runId: z.string(),
  toolCalls: z.array(ToolCallSummary),
});
export type ChatResponse = z.infer<typeof ChatResponse>;
