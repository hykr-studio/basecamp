// Ready-made agents an application offers (`agentTemplates`), and the connector agents take
// webhooks from. Nothing here reads the configuration or loads Nest: safe to import from an
// application module at load time.
import { standardWebhooks } from '@hykr/connectors';
import {
  AgentBudget,
  AgentScope,
  type AgentTemplateDef,
  AgentTrigger,
  createHookRegistry,
} from '@hykr/contracts';
import { z } from 'zod';
import { type ConnectorHandler, defineConnectorHandler } from '../integrations/registry.js';

declare module '@hykr/contracts' {
  interface Contributions {
    agentTemplates: readonly AgentTemplateDef[];
  }
}

const KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** A template, checked: its key, its triggers, scope and budget as a definition takes them. */
export function defineAgentTemplate(def: AgentTemplateDef): AgentTemplateDef {
  if (!KEY.test(def.key))
    throw new Error(`Agent template "${def.key}": lower case words joined by "." or "-"`);
  const parsed = z
    .object({
      instructions: z.string().trim().min(1).max(4000),
      triggers: z.array(AgentTrigger).max(10),
      scope: AgentScope,
      budget: AgentBudget.optional(),
    })
    .safeParse(def);
  if (!parsed.success)
    throw new Error(
      `Agent template "${def.key}": ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return def;
}

/** Ready-made agents, by key. Contribute them as `agentTemplates`; the framework has none. */
export const agentTemplates = createHookRegistry<AgentTemplateDef>(
  'agent template',
  (t) => defineAgentTemplate(t).key,
  { collects: 'agentTemplates' },
);

/**
 * Signed webhooks for agents: a business adds a connection of it (`integrations.manage`), and an
 * agent's `webhook` trigger names the connection. Signed the Standard Webhooks way.
 */
export const agentWebhooks = {
  ...standardWebhooks,
  name: 'agent-webhooks',
  label: {
    en: 'Webhooks for agents',
    hi: 'एजेंट के लिए वेबहुक',
    te: 'ఏజెంట్‌ల కోసం వెబ్‌హుక్‌లు',
  },
  description: {
    en: 'Any system that signs its webhooks the Standard Webhooks way, to start the business’s agents.',
    hi: 'कोई भी सिस्टम जो Standard Webhooks तरीके से वेबहुक साइन करता है, व्यवसाय के एजेंट शुरू करने के लिए।',
    te: 'వ్యాపార ఏజెంట్‌లను ప్రారంభించడానికి, Standard Webhooks పద్ధతిలో వెబ్‌హుక్‌లపై సంతకం చేసే ఏ సిస్టమ్ అయినా.',
  },
} satisfies typeof standardWebhooks;

/** What a connector handler hands the agents feature: the stored event. */
export type AgentWebhookSink = (event: {
  id: string;
  tenantId: string;
  connectionId: string;
  connector: string;
  type: string;
  data: unknown;
}) => Promise<void>;

let sink: AgentWebhookSink | undefined;

/** The agents feature installs where inbound events go when it starts. */
export function setAgentWebhookSink(next?: AgentWebhookSink) {
  sink = next;
}

/**
 * Let the business's agents take a connector's inbound events: each stored event of a connection
 * an agent's `webhook` trigger names starts that agent. The feature contributes it for
 * `agent-webhooks`; an application contributes it for a connector of its own.
 */
export function agentWebhookHandler(connector: string): ConnectorHandler {
  return defineConnectorHandler({
    name: `agents.${connector}`,
    connector,
    on: ['*'],
    handle: async (event) => {
      if (!sink) throw new Error('The agents feature is not running');
      await sink(event);
    },
  });
}
