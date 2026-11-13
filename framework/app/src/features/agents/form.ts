// The agent editor's form, without React: a definition as fields people type, back to what the
// API takes, and a line about each trigger. Tested without React Native.
import type {
  Agent,
  AgentRunStatus,
  AgentTemplateInfo,
  AgentTrigger,
  AgentTriggerKind,
  CreateAgentInput,
} from '@hykr/contracts';

/** One trigger as the editor holds it: every field as text. */
export type TriggerDraft = {
  kind: AgentTriggerKind;
  /** once: the time; recurring: the cron pattern. */
  when: string;
  timeZone: string;
  /** event and webhook: names or types, comma-separated; message: words. */
  list: string;
  /** condition: the entity; webhook: the connection. */
  target: string;
  /** event and condition: JSON. */
  where: string;
  everyMinutes: string;
};

export type AgentDraft = {
  name: string;
  description: string;
  instructions: string;
  triggers: TriggerDraft[];
  tools: string[];
  period: 'day' | 'week' | 'month';
  runs: string;
  tokens: string;
  credits: string;
  maxSteps: string;
  template: string | null;
};

export const TRIGGER_KINDS: readonly { kind: AgentTriggerKind; label: string }[] = [
  { kind: 'recurring', label: 'Schedule' },
  { kind: 'once', label: 'Once' },
  { kind: 'event', label: 'Event' },
  { kind: 'condition', label: 'Condition' },
  { kind: 'message', label: 'WhatsApp message' },
  { kind: 'mention', label: '@-mention' },
  { kind: 'webhook', label: 'Webhook' },
];

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const num = (s: string) => (s.trim() === '' ? undefined : Number(s.trim()));

export function blankTrigger(kind: AgentTriggerKind): TriggerDraft {
  return {
    kind,
    when: kind === 'recurring' ? '0 9 * * 1' : '',
    timeZone: '',
    list: kind === 'event' ? '' : kind === 'webhook' ? '*' : '',
    target: '',
    where: kind === 'condition' ? '{}' : '',
    everyMinutes: '15',
  };
}

export function triggerDraft(t: AgentTrigger): TriggerDraft {
  const d = blankTrigger(t.kind);
  switch (t.kind) {
    case 'once':
      return { ...d, when: t.at };
    case 'recurring':
      return { ...d, when: t.cron, timeZone: t.timeZone ?? '' };
    case 'event':
      return { ...d, list: t.on.join(', '), where: t.where ? JSON.stringify(t.where) : '' };
    case 'condition':
      return {
        ...d,
        target: t.entity,
        where: JSON.stringify(t.where),
        everyMinutes: String(t.everyMinutes),
      };
    case 'message':
      return { ...d, list: (t.contains ?? []).join(', ') };
    case 'webhook':
      return { ...d, target: t.connectionId, list: t.on.join(', ') };
    default:
      return d;
  }
}

/** A blank agent, or one from a template. */
export function newDraft(template?: AgentTemplateInfo): AgentDraft {
  return {
    name: template?.name ?? '',
    description: template?.description ?? '',
    instructions: template?.instructions ?? '',
    triggers: (template?.triggers ?? []).map(triggerDraft),
    tools: [...(template?.scope.tools ?? [])],
    period: template?.budget.period ?? 'month',
    runs: template?.budget.runs ? String(template.budget.runs) : '',
    tokens: template?.budget.tokens ? String(template.budget.tokens) : '',
    credits: template?.budget.credits ? String(template.budget.credits) : '',
    maxSteps: String(template?.budget.maxSteps ?? 6),
    template: template?.key ?? null,
  };
}

/** An agent the person has, as the editor shows it. */
export function draftOf(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    triggers: agent.triggers.map(triggerDraft),
    tools: [...agent.scope.tools],
    period: agent.budget.period,
    runs: agent.budget.runs ? String(agent.budget.runs) : '',
    tokens: agent.budget.tokens ? String(agent.budget.tokens) : '',
    credits: agent.budget.credits ? String(agent.budget.credits) : '',
    maxSteps: String(agent.budget.maxSteps),
    template: agent.template,
  };
}

/** A trigger as the API takes it, or why the typed fields are not one. */
function triggerOf(d: TriggerDraft): { trigger: unknown } | { error: string } {
  const json = (s: string, what: string) => {
    if (!s.trim()) return undefined;
    try {
      return JSON.parse(s) as unknown;
    } catch {
      throw new Error(`${what} is not JSON`);
    }
  };
  try {
    switch (d.kind) {
      case 'once': {
        const at = new Date(d.when);
        if (Number.isNaN(at.getTime())) return { error: 'Once: give a date and time' };
        return { trigger: { kind: 'once', at: at.toISOString() } };
      }
      case 'recurring':
        return {
          trigger: {
            kind: 'recurring',
            cron: d.when.trim(),
            ...(d.timeZone.trim() ? { timeZone: d.timeZone.trim() } : {}),
          },
        };
      case 'event': {
        const where = json(d.where, 'The event’s condition');
        return {
          trigger: { kind: 'event', on: list(d.list), ...(where ? { where } : {}) },
        };
      }
      case 'condition':
        return {
          trigger: {
            kind: 'condition',
            entity: d.target.trim(),
            where: json(d.where, 'The condition') ?? {},
            everyMinutes: num(d.everyMinutes) ?? 15,
          },
        };
      case 'message': {
        const words = list(d.list);
        return { trigger: { kind: 'message', ...(words.length ? { contains: words } : {}) } };
      }
      case 'mention':
        return { trigger: { kind: 'mention' } };
      case 'webhook':
        return {
          trigger: {
            kind: 'webhook',
            connectionId: d.target.trim(),
            on: list(d.list).length ? list(d.list) : ['*'],
          },
        };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** The definition the API takes, or the first thing to fix in the form. */
export function inputOf(d: AgentDraft): { input: CreateAgentInput } | { error: string } {
  if (!d.name.trim()) return { error: 'Give the agent a name' };
  if (!d.instructions.trim()) return { error: 'Say what the agent does' };
  const triggers: unknown[] = [];
  for (const t of d.triggers) {
    const made = triggerOf(t);
    if ('error' in made) return made;
    triggers.push(made.trigger);
  }
  const budget = {
    period: d.period,
    ...(num(d.runs) ? { runs: num(d.runs) } : {}),
    ...(num(d.tokens) ? { tokens: num(d.tokens) } : {}),
    ...(num(d.credits) ? { credits: num(d.credits) } : {}),
    maxSteps: num(d.maxSteps) ?? 6,
  };
  return {
    input: {
      name: d.name.trim(),
      description: d.description.trim(),
      instructions: d.instructions.trim(),
      triggers: triggers as CreateAgentInput['triggers'],
      scope: { tools: d.tools },
      budget,
      ...(d.template ? { template: d.template } : {}),
    },
  };
}

/** A line about a trigger, as the list and the editor say it. */
export function triggerWords(t: AgentTrigger): string {
  switch (t.kind) {
    case 'once':
      return `Once, ${new Date(t.at).toLocaleString()}`;
    case 'recurring':
      return `On the schedule ${t.cron}${t.timeZone ? ` (${t.timeZone})` : ''}`;
    case 'event':
      return `When ${t.on.join(' or ')} happens`;
    case 'condition':
      return `When a ${t.entity} matches (checked every ${t.everyMinutes} min)`;
    case 'message':
      return t.contains?.length
        ? `On a WhatsApp message with ${t.contains.join(' or ')}`
        : 'On any WhatsApp message';
    case 'mention':
      return 'When someone @-mentions it';
    case 'webhook':
      return `On a webhook (${t.on.join(', ')})`;
  }
}

/** How a run's status reads, and its tone. */
export const RUN_STATUS: Readonly<
  Record<
    AgentRunStatus,
    { label: string; tone: 'neutral' | 'info' | 'success' | 'warn' | 'danger' }
  >
> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  waiting: { label: 'Waiting for approval', tone: 'warn' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  refused: { label: 'Refused', tone: 'danger' },
};
