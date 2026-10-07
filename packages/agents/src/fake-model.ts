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
 *   add <title>                     create-todo
 *   list                            list-todos
 *   done <title>                    list-todos → update-todo { done: true }
 *   delete <title>                  list-todos → delete-todo (parked for approval)
 *   today                           list-meetings + list-todos for today → summary
 *   close <meeting>\n<summary>\n- item …   list-meetings → close-meeting (parked for approval)
 *   move <meeting> to <YYYY-MM-DD>  list-meetings → reschedule-meeting
 *
 * It plans each step from the tool results so far in this turn, like a real model would.
 */
type Row = Record<string, unknown> & { id: string; title: string };
type Outcome = { ok: boolean; result?: unknown; status?: number; error?: unknown };
type Step = { toolName: string; outcome: Outcome };

let callCounter = 0;

/** The person's time zone, as the instructions state it ("The user's time zone is X"). */
function zoneOf(prompt: LanguageModelV2Prompt): string {
  for (const message of prompt) {
    if (message.role !== 'system') continue;
    const m = /time zone is ([A-Za-z0-9_+\-/]+)/.exec(message.content);
    if (m) return m[1];
  }
  return 'UTC';
}

/** The instant at which `day` (YYYY-MM-DD) starts in `zone`. */
function startOfDay(day: string, zone: string): Date {
  const utc = new Date(`${day}T00:00:00Z`);
  const wall = (d: Date, tz: string) =>
    new Date(d.toLocaleString('en-US', { timeZone: tz })).getTime();
  return new Date(utc.getTime() - (wall(utc, zone) - wall(utc, 'UTC')));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function lastUserText(prompt: LanguageModelV2Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message.role !== 'user') continue;
    return message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n')
      .trim();
  }
  return '';
}

/** Tool results since the last user message, oldest first. */
function stepsThisTurn(prompt: LanguageModelV2Prompt): Step[] {
  const steps: Step[] = [];
  for (let i = prompt.length - 1; i >= 0 && prompt[i].role !== 'user'; i--) {
    const message = prompt[i];
    if (message.role !== 'tool') continue;
    for (const part of [...message.content].reverse()) {
      const output = part.output as { value: unknown };
      steps.unshift({ toolName: part.toolName, outcome: output.value as Outcome });
    }
  }
  return steps;
}

const call = (toolName: string, args: unknown): LanguageModelV2Content => ({
  type: 'tool-call',
  toolCallId: `call_${++callCounter}`,
  toolName,
  input: JSON.stringify(args),
});
const text = (value: string): LanguageModelV2Content => ({ type: 'text', text: value });

const items = (o?: Outcome) => ((o?.result as { items?: Row[] } | undefined)?.items ?? []) as Row[];
const why = (o: Outcome) => {
  const body = o.error as { reason?: string; message?: unknown } | null;
  return (
    body?.reason ??
    (typeof body?.message === 'string' ? body.message : `the API answered ${o.status}`)
  );
};
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What a finished write says: done, or what is waiting for approval. */
function written(o: Outcome, done: (value: Row) => string): string {
  const r = o.result as { status: string; value?: Row; approval?: { summary: string | null } };
  if (r.status === 'needs_approval') {
    return `I've asked for your approval: ${r.approval?.summary ?? 'see Approvals'}. Approve it in the app.`;
  }
  return done(r.value as Row);
}

type Intent =
  | { verb: 'add' | 'done' | 'delete'; title: string }
  | { verb: 'list' | 'today' }
  | { verb: 'close'; title: string; summary: string; items: string[] }
  | { verb: 'move'; title: string; date: string };

function parse(input: string): Intent | undefined {
  const [first = '', ...rest] = input.split('\n');
  const move = /^move (.+) to (\d{4}-\d{2}-\d{2})$/i.exec(first.trim());
  if (move) return { verb: 'move', title: move[1], date: move[2] };
  const m = /^(add|done|delete|close|list|today)\b\s*(.*)$/i.exec(first.trim());
  if (!m) return undefined;
  const verb = m[1].toLowerCase();
  if (verb === 'list' || verb === 'today') return { verb };
  if (verb === 'close') {
    const lines = rest.map((l) => l.trim()).filter(Boolean);
    return {
      verb,
      title: m[2],
      summary: lines.find((l) => !l.startsWith('- ')) ?? `Closed ${m[2]}.`,
      items: lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()),
    };
  }
  return { verb: verb as 'add' | 'done' | 'delete', title: m[2] };
}

/** Decide the next step from the conversation so far. */
export function script(prompt: LanguageModelV2Prompt): LanguageModelV2Content[] {
  const intent = parse(lastUserText(prompt));
  const steps = stepsThisTurn(prompt);
  const last = steps.at(-1);
  if (last && !last.outcome.ok) return [text(`I couldn't do that: ${why(last.outcome)}.`)];
  const result = (tool: string) => steps.find((s) => s.toolName === tool)?.outcome;

  if (!intent)
    return [
      text('I can add, list, complete or delete to-dos, show today, and close or move meetings.'),
    ];

  switch (intent.verb) {
    case 'add': {
      const r = result('create-todo');
      if (!r) return [call('create-todo', { title: intent.title })];
      return [text(written(r, (t) => `Added "${t.title}".`))];
    }
    case 'list': {
      const r = result('list-todos');
      if (!r) return [call('list-todos', {})];
      const todos = items(r);
      return [
        text(
          todos.length
            ? todos.map((t) => `[${t.done ? 'x' : ' '}] ${t.title}`).join('\n')
            : 'You have no to-dos.',
        ),
      ];
    }
    case 'done':
    case 'delete': {
      const tool = intent.verb === 'done' ? 'update-todo' : 'delete-todo';
      const r = result(tool);
      if (r)
        return [
          text(written(r, (t) => (intent.verb === 'done' ? `Updated "${t.title}".` : 'Deleted.'))),
        ];
      const list = result('list-todos');
      if (!list) return [call('list-todos', {})];
      const target = items(list).find((t) => sameTitle(t.title, intent.title));
      if (!target) return [text(`I couldn't find a to-do called "${intent.title}".`)];
      return [
        call(tool, intent.verb === 'done' ? { id: target.id, done: true } : { id: target.id }),
      ];
    }
    case 'today': {
      const zone = zoneOf(prompt);
      const day = new Date().toLocaleDateString('sv', { timeZone: zone });
      const meetings = result('list-meetings');
      if (!meetings) {
        const start = startOfDay(day, zone);
        return [
          call('list-meetings', {
            startsAt: {
              gte: start.toISOString(),
              lte: new Date(start.getTime() + 86_399_999).toISOString(),
            },
            sort: 'startsAt',
          }),
        ];
      }
      const todos = result('list-todos');
      if (!todos) return [call('list-todos', { done: false, dueOn: { lte: day }, sort: 'dueOn' })];
      const at = (iso: unknown) =>
        new Date(String(iso)).toLocaleTimeString('en-GB', {
          timeZone: zone,
          hour: '2-digit',
          minute: '2-digit',
        });
      const m = items(meetings).map((x) => `- ${x.title} at ${at(x.startsAt)}`);
      const t = items(todos).map((x) => `- ${x.title}${x.dueOn ? ` (due ${x.dueOn})` : ''}`);
      return [
        text(
          [
            `Today: ${plural(m.length, 'meeting')}, ${plural(t.length, 'to-do')} due or overdue.`,
            ...m,
            ...(t.length ? ['To-dos:', ...t] : []),
          ].join('\n'),
        ),
      ];
    }
    case 'close':
    case 'move': {
      const tool = intent.verb === 'close' ? 'close-meeting' : 'reschedule-meeting';
      const r = result(tool);
      if (r) {
        return [
          text(
            written(r, () =>
              intent.verb === 'close'
                ? `Closed ${intent.title}.`
                : `Moved ${intent.title} to ${(intent as { date: string }).date}.`,
            ),
          ),
        ];
      }
      const list = result('list-meetings');
      if (!list) return [call('list-meetings', { q: intent.title })];
      const meeting = items(list).find((x) => sameTitle(x.title, intent.title)) ?? items(list)[0];
      if (!meeting) return [text(`I couldn't find a meeting called "${intent.title}".`)];
      if (intent.verb === 'close') {
        return [
          call('close-meeting', {
            meetingId: meeting.id,
            summary: intent.summary,
            decisions: [],
            actionItems: intent.items.map((title) => ({ title })),
          }),
        ];
      }
      // Keep the time of day and the length; change the date.
      const start = new Date(String(meeting.startsAt));
      const length = new Date(String(meeting.endsAt)).getTime() - start.getTime();
      const startsAt = new Date(`${intent.date}T${start.toISOString().slice(11)}`);
      return [
        call('reschedule-meeting', {
          meetingId: meeting.id,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + length).toISOString(),
        }),
      ];
    }
  }
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
      return { content, finishReason: calledTool ? 'tool-calls' : 'stop', usage, warnings: [] };
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
