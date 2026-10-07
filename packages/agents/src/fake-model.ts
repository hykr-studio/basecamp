import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';

/**
 * A scripted model for tests and CI: the real agent loop, no network, no cost.
 *
 *   add <title>     -> add-todo
 *   list            -> list-todos
 *   delete <title>  -> list-todos, then delete-todo with the matching id
 *   done <title>    -> list-todos, then update-todo { done: true }
 *
 * After a tool result it either chains the next call or answers in text.
 */
type TodoLite = { id: string; title: string; done: boolean };
type ToolOutcome = { ok: boolean; result?: unknown; status?: number; error?: unknown };

let callCounter = 0;
const toolCallId = () => `call_${++callCounter}`;

function lastUserText(prompt: LanguageModelV2Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message.role !== 'user') continue;
    return message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join(' ')
      .trim();
  }
  return '';
}

/** The tool results since the last user message, newest last. */
function latestToolResult(prompt: LanguageModelV2Prompt) {
  const last = prompt.at(-1);
  if (last?.role !== 'tool') return undefined;
  const part = last.content.at(-1);
  if (!part) return undefined;
  const output = part.output as { type: string; value: unknown };
  return { toolName: part.toolName, outcome: output.value as ToolOutcome };
}

function call(toolName: string, args: unknown): LanguageModelV2Content {
  return { type: 'tool-call', toolCallId: toolCallId(), toolName, input: JSON.stringify(args) };
}

function text(value: string): LanguageModelV2Content {
  return { type: 'text', text: value };
}

function errorText(outcome: ToolOutcome) {
  const body = outcome.error as { reason?: string; message?: string } | null;
  return body?.reason ?? body?.message ?? `the API answered ${outcome.status}`;
}

const parse = (input: string) => {
  const match = /^(add|delete|done|list)\b\s*(.*)$/i.exec(input);
  return match ? { verb: match[1].toLowerCase(), rest: match[2].trim() } : undefined;
};

/** Decide the next step from the conversation so far. */
export function script(prompt: LanguageModelV2Prompt): LanguageModelV2Content[] {
  const intent = parse(lastUserText(prompt));
  const tool = latestToolResult(prompt);

  if (!tool) {
    if (!intent) return [text('I can add, list, delete, or complete to-dos.')];
    if (intent.verb === 'add') return [call('add-todo', { title: intent.rest })];
    return [call('list-todos', {})];
  }

  const { toolName, outcome } = tool;
  if (!outcome.ok) return [text(`I couldn't do that: ${errorText(outcome)}.`)];

  if (toolName === 'list-todos') {
    const todos = (outcome.result ?? []) as TodoLite[];
    if (intent?.verb === 'delete' || intent?.verb === 'done') {
      const target = todos.find((t) => t.title.toLowerCase() === intent.rest.toLowerCase());
      if (!target) return [text(`I couldn't find a to-do called "${intent.rest}".`)];
      return intent.verb === 'delete'
        ? [call('delete-todo', { id: target.id })]
        : [call('update-todo', { id: target.id, done: true })];
    }
    if (todos.length === 0) return [text('You have no to-dos.')];
    return [text(todos.map((t) => `[${t.done ? 'x' : ' '}] ${t.title}`).join('\n'))];
  }

  const result = outcome.result as
    | { status: 'done'; todo: TodoLite | null }
    | { status: 'needs_approval'; approval: { summary: string | null } };
  if (result.status === 'needs_approval') {
    return [text(`I've asked for your approval: ${result.approval.summary ?? 'see Approvals'}.`)];
  }
  if (toolName === 'add-todo') return [text(`Added "${result.todo?.title}".`)];
  if (toolName === 'update-todo') return [text(`Updated "${result.todo?.title}".`)];
  return [text('Done.')];
}

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export function fakeModel(): LanguageModelV2 {
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'scripted',
    supportedUrls: {},

    // agent.generate() calls doGenerate, not doStream.
    async doGenerate(options: LanguageModelV2CallOptions) {
      const content = script(options.prompt);
      const calledTool = content.some((part) => part.type === 'tool-call');
      return {
        content,
        finishReason: calledTool ? 'tool-calls' : 'stop',
        usage,
        warnings: [],
      };
    },

    async doStream(options: LanguageModelV2CallOptions) {
      const content = script(options.prompt);
      const calledTool = content.some((part) => part.type === 'tool-call');
      const parts: LanguageModelV2StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      for (const part of content) {
        if (part.type === 'text') {
          parts.push(
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: part.text },
            { type: 'text-end', id: 't1' },
          );
        } else if (part.type === 'tool-call') {
          parts.push(part);
        }
      }
      parts.push({ type: 'finish', finishReason: calledTool ? 'tool-calls' : 'stop', usage });
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}
