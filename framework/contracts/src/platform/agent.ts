// Agents a business makes (A6): a definition (instructions, owner, scope, budget, triggers), run
// when a trigger fires, acting for its owner and never beyond them; every run in a run log.
// What agents are offered ready-made (templates) is the application's. docs/decisions/A6.md.
import type { Labels } from '@hykr/i18n';
import { z } from 'zod';
import { ThreadMessage, ToolCallSummary } from '../chat.js';
import { storableDateTime } from '../framework/instant.js';
import { CreatedBy, commandSpec, entitySpec } from '../framework/spec.js';
import { defineCapability } from '../roles.js';

/** The header an agent run's tool calls carry instead of an agent key (with x-run-id). */
export const AGENT_RUN_HEADER = 'x-agent-run';

/** An event name or a prefix: 'task.created', 'task.*', '*'. */
const EventPattern = z
  .string()
  .regex(
    /^(?:\*|[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*(?:\.\*)?)$/,
    'An event name, "<prefix>.*" or "*"',
  );

/** One field of a record equal to a value: what an event trigger's `where` holds. */
const Scalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

/** A five-field cron pattern: minute hour day-of-month month day-of-week. */
const Cron = z
  .string()
  .trim()
  .regex(/^\S+(\s+\S+){4}$/, 'Five fields: minute hour day month weekday')
  .max(100);

const Where = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/), z.unknown());

/**
 * What starts an agent: a time, a schedule, a stored event, a condition becoming true for a
 * record, a WhatsApp message to the business, an @-mention in a comment, or a signed webhook.
 */
export const AgentTrigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: storableDateTime({ offset: true }) }).strict(),
  z
    .object({
      kind: z.literal('recurring'),
      cron: Cron,
      /** An IANA zone; the business's own when omitted. */
      timeZone: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('event'),
      on: z.array(EventPattern).min(1).max(10),
      /** Fields of the record (as the owner sees it) that must equal these values. */
      where: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/), Scalar).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('condition'),
      /** The entity's name ('task'). */
      entity: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
      /** The entity's list filters; `$now` and `$today` (± `<n>m`, `h` or `d`) move with time. */
      where: Where,
      everyMinutes: z.number().int().min(5).max(1440).default(15),
    })
    .strict(),
  z
    .object({
      kind: z.literal('message'),
      /** Only messages with one of these words; any message when omitted. */
      contains: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('mention') }).strict(),
  z
    .object({
      kind: z.literal('webhook'),
      /** A connection of a connector agents take events from (`agent-webhooks`). */
      connectionId: z.uuid(),
      on: z.array(z.string().min(1).max(200)).min(1).max(10).default(['*']),
    })
    .strict(),
]);
export type AgentTrigger = z.infer<typeof AgentTrigger>;
export type AgentTriggerInput = z.input<typeof AgentTrigger>;
export type AgentTriggerKind = AgentTrigger['kind'];

export const AGENT_TRIGGER_KINDS = [
  'once',
  'recurring',
  'event',
  'condition',
  'message',
  'mention',
  'webhook',
] as const satisfies readonly AgentTriggerKind[];

/** The assistant's tools the agent may use, by id ('list-todos'). Nothing else. */
export const AgentScope = z
  .object({ tools: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).max(50) })
  .strict();
export type AgentScope = z.infer<typeof AgentScope>;

/**
 * What an agent may use per period, in the business's time zone: runs, model tokens, and credits
 * (minor units of the deployment's credits currency). At 100% of any, runs are refused.
 */
export const AgentBudget = z
  .object({
    period: z.enum(['day', 'week', 'month']).default('month'),
    runs: z.number().int().min(1).max(100_000).optional(),
    tokens: z.number().int().min(1).optional(),
    credits: z.number().int().min(1).optional(),
    /** Model steps per run (each step may call tools). */
    maxSteps: z.number().int().min(1).max(8).default(6),
  })
  .strict();
export type AgentBudget = z.infer<typeof AgentBudget>;

export const AgentStatus = z.enum(['active', 'paused']);
export type AgentStatus = z.infer<typeof AgentStatus>;

const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(300);
const instructions = z.string().trim().min(1).max(4000);
const TemplateKey = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);

/** An agent of the business, as its owner and the business's managers see it. */
export const Agent = z.object({
  id: z.string(),
  name,
  description: z.string(),
  instructions: z.string(),
  /** The person it acts for: who made it. */
  ownerId: z.string(),
  triggers: z.array(AgentTrigger),
  scope: AgentScope,
  budget: AgentBudget,
  status: AgentStatus,
  /** The template it was made from, if any. */
  template: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof Agent>;

export const CreateAgentInput = z.object({
  name,
  description: description.default(''),
  instructions,
  triggers: z.array(AgentTrigger).max(10).default([]),
  scope: AgentScope.default({ tools: [] }),
  budget: AgentBudget.default({ period: 'month', maxSteps: 6 }),
  status: AgentStatus.default('active'),
  template: TemplateKey.nullable().optional(),
});
export type CreateAgentInput = z.input<typeof CreateAgentInput>;

export const UpdateAgentInput = z
  .object({
    name: name.optional(),
    description: description.optional(),
    instructions: instructions.optional(),
    triggers: z.array(AgentTrigger).max(10).optional(),
    scope: AgentScope.optional(),
    budget: AgentBudget.optional(),
    status: AgentStatus.optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    'Send at least one field to change',
  );
export type UpdateAgentInput = z.input<typeof UpdateAgentInput>;

/**
 * The business's agents: each runs the assistant with its own instructions when a trigger fires,
 * acting for its owner (never with more than they may do), with only the tools in its scope.
 */
export const AgentSpec = entitySpec({
  name: 'agent',
  label: 'agent',
  description:
    'Agents the user set up: each does a job on its own when its trigger fires (a time, a schedule, an event, a condition, a WhatsApp message, an @-mention or a webhook), acting for the user with only the tools in its scope. When the user describes a job for an agent, draft it with create-agent: a short name, the instructions in their words, the triggers (recurring: a five-field cron in their time zone) and the fewest tools that do the job (scope.tools: tool ids you have, never an agent or canvas tool). The user approves the draft.',
  schemas: { read: Agent, create: CreateAgentInput, update: UpdateAgentInput },
  fieldLabels: {
    name: { en: 'Name', hi: 'नाम', te: 'పేరు' },
    description: { en: 'Description', hi: 'विवरण', te: 'వివరణ' },
    instructions: { en: 'Instructions', hi: 'निर्देश', te: 'సూచనలు' },
    triggers: { en: 'Triggers', hi: 'ट्रिगर', te: 'ట్రిగ్గర్లు' },
    scope: { en: 'Tools it may use', hi: 'इस्तेमाल के टूल', te: 'వాడగల సాధనాలు' },
    budget: { en: 'Budget', hi: 'बजट', te: 'బడ్జెట్' },
    status: { en: 'Status', hi: 'स्थिति', te: 'స్థితి' },
  },
  list: {
    filterable: { name: 'text', status: 'enum', ownerId: 'id', updatedAt: 'date' },
    sortable: ['name', 'updatedAt', 'createdAt'],
    defaultSort: [['updatedAt', 'desc']],
    search: ['name', 'description'],
    pageSize: { default: 50, max: 100 },
    examples: { name: '{ "contains": "summary" }', status: '"active"' },
  },
  // The assistant drafts and changes agents for the person; the person approves each.
  approval: {
    create: (p) => p.actor.kind === 'agent',
    update: (p) => p.actor.kind === 'agent',
    delete: (p) => p.actor.kind === 'agent',
  },
  traits: { comments: false },
});

/** `agent.run`: run an agent now, as if a trigger fired. */
export const RunAgentSpec = commandSpec({
  name: 'agent.run',
  description:
    'Run one of the user’s agents now (get its id from list-agents). It runs in the background; its run log says what it did.',
  input: z.object({
    agentId: z.uuid(),
    /** Passed to the run as data. Only the agent's owner may give one. */
    note: z.string().trim().max(1000).optional(),
  }),
  output: z.object({ id: z.string(), agentId: z.string(), status: z.literal('queued') }),
  http: { method: 'POST', path: '/api/agents/:agentId/run' },
  tool: 'run-agent',
  expose: 'all',
  verb: { do: 'run', did: 'ran' },
  touches: [],
});

/** Every tool id that manages agents: never in an agent's scope. */
export const agentToolIds = (): readonly string[] => [
  'list-agents',
  'get-agent',
  'create-agent',
  'update-agent',
  'delete-agent',
  'summarize-agents',
  'run-agent',
];

/* ── Runs ──────────────────────────────────────────────────────────────── */

export const AgentRunStatus = z.enum(['queued', 'running', 'waiting', 'done', 'failed', 'refused']);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

/** What started a run: the trigger's kind (or 'manual' for run now) and a short description. */
export const AgentRunTrigger = z.object({
  kind: z.enum([...AGENT_TRIGGER_KINDS, 'manual']),
  label: z.string(),
});
export type AgentRunTrigger = z.infer<typeof AgentRunTrigger>;

/** One run of an agent, as its log keeps it. */
export const AgentRun = z.object({
  id: z.string(),
  agentId: z.string(),
  /** Its run id: its audit rows, its trace, its messages. */
  runId: z.string(),
  trigger: AgentRunTrigger,
  status: AgentRunStatus,
  /** Why it was refused or failed. */
  reason: z.string().nullable(),
  reply: z.string().nullable(),
  toolCalls: z.array(ToolCallSummary),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  model: z.string().nullable(),
  agentVersion: z.string().nullable(),
  /** How many runs of other agents led to this one (0: a person or the clock started it). */
  depth: z.number(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type AgentRun = z.infer<typeof AgentRun>;

export const AgentRunPage = z.object({
  items: z.array(AgentRun),
  nextCursor: z.string().nullable(),
});
export type AgentRunPage = z.infer<typeof AgentRunPage>;

/** One run with what was said in it: its message, the replies, the tools' parts. */
export const AgentRunDetail = AgentRun.extend({ messages: z.array(ThreadMessage) });
export type AgentRunDetail = z.infer<typeof AgentRunDetail>;

/** `GET /api/agent-runs`: one agent's runs (or every run the caller may see), newest first. */
export const AgentRunsQuery = z
  .object({
    agentId: z.uuid().optional(),
    status: AgentRunStatus.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type AgentRunsQuery = {
  agentId?: string;
  status?: AgentRunStatus;
  cursor?: string;
  limit?: number;
};

/* ── Templates ─────────────────────────────────────────────────────────── */

/** A ready-made agent the application offers (`defineAgentTemplate` in @hykr/api). */
export interface AgentTemplateDef {
  /** Unique, lower case words joined by '.' or '-': 'meetings.weekly-todos'. */
  key: string;
  name: Labels;
  description: Labels;
  instructions: string;
  triggers: readonly AgentTriggerInput[];
  scope: AgentScope;
  budget?: z.input<typeof AgentBudget>;
}

/** A template as the API lists it: in the reader's language, and whether it can be made here. */
export const AgentTemplateInfo = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  triggers: z.array(AgentTrigger),
  scope: AgentScope,
  budget: AgentBudget,
  /** Every tool and entity it names is served here. */
  available: z.boolean(),
});
export type AgentTemplateInfo = z.infer<typeof AgentTemplateInfo>;

/** `GET /api/agent-templates`: the templates, and every tool an agent may be given here. */
export const AgentTemplates = z.object({
  items: z.array(AgentTemplateInfo),
  tools: z.array(z.string()),
});
export type AgentTemplates = z.infer<typeof AgentTemplates>;

/* ── Capabilities ──────────────────────────────────────────────────────── */

export const AgentCapabilities = {
  /** Make agents that act for you. */
  create: defineCapability({
    name: 'agents.create',
    label: {
      en: 'Make agents that act for you',
      hi: 'अपनी ओर से काम करने वाले एजेंट बनाएँ',
      te: 'మీ తరఫున పనిచేసే ఏజెంట్‌లను తయారు చేయండి',
    },
    roles: ['owner', 'admin'],
    // An agent acts later, by itself: support leaves nothing that acts after it ends.
    supportable: false,
  }),
  /** See every agent and run log; pause, run and delete anyone's agent. */
  manage: defineCapability({
    name: 'agents.manage',
    label: {
      en: "See, pause, run and delete everyone's agents",
      hi: 'सभी के एजेंट देखें, रोकें, चलाएँ और हटाएँ',
      te: 'అందరి ఏజెంట్‌లను చూడండి, ఆపండి, నడపండి, తొలగించండి',
    },
    roles: ['owner', 'admin'],
    // Running someone's agent acts as them: more than the business consented to.
    supportable: false,
  }),
} as const;
