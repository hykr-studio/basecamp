import { type AgentDomain, type Agents, createAgents } from '@hykr/agents';
import { type Catalog, createCatalog, type Domain } from '@hykr/contracts';
import type { MigrationSet } from '@hykr/db';
import type { Labels } from '@hykr/i18n';
import {
  createNotificationCatalog,
  type NotificationCatalog,
  type NotificationsDomain,
} from '@hykr/notifications';
import { createUiRegistry, type Registry, type UiDomain } from '@hykr/ui-registry';
import type { DynamicModule, Type } from '@nestjs/common';

/**
 * Everything an application gives the server: its domain (entities and commands), the Nest
 * module that serves them, its views, what it sends, and what its assistant knows. The
 * framework never imports an application; the application passes this in.
 */
export interface ServerDefinition {
  /** Entities and commands: `defineDomain(...)` from @hykr/contracts. */
  domain: Domain;
  /** The Nest module with one `defineEntity` / `defineCommand` per spec. */
  module: Type<unknown> | DynamicModule;
  /** Views and screens the assistant may show (@hykr/ui-registry). */
  views?: UiDomain;
  /** Templates and notifications (@hykr/notifications). */
  notifications?: NotificationsDomain;
  /** Persona, rules, the scripted model's scripts and the eval cases (@hykr/agents). */
  agent: AgentDomain;
  /** On WhatsApp: what the assistant helps with, one sentence per language (welcome, HELP). */
  channel?: { does: Labels };
  /** The application's migrations, applied after the framework's (`basecamp db migrate`). */
  migrations?: MigrationSet[];
}

/** An application as the server runs it: its definition, built into the framework's parts. */
export interface Basecamp {
  definition: ServerDefinition;
  catalog: Catalog;
  registry: Registry;
  notifications: NotificationCatalog;
  /** The assistant, built on first use (the templates CLI and migrations never need it). */
  readonly agents: Agents;
}

export function defineServer(definition: ServerDefinition): Basecamp {
  const catalog = createCatalog(definition.domain);
  const registry = createUiRegistry(definition.views);
  let agents: Agents | undefined;
  return {
    definition,
    catalog,
    registry,
    notifications: createNotificationCatalog(definition.notifications),
    get agents() {
      agents ??= createAgents({ catalog, registry, domain: definition.agent });
      return agents;
    },
  };
}

let current: Basecamp | undefined;

/**
 * The application this process serves. Set once, before the Nest modules load (startApi,
 * startWorker, the templates CLI and the test harness do it), so a module can read it while
 * it is defined.
 */
export function runtime(): Basecamp {
  if (!current)
    throw new Error('No application registered: start the server with startApi(defineServer(...))');
  return current;
}

export function setRuntime(app: Basecamp) {
  if (current && current !== app) throw new Error('Another application is already registered');
  current = app;
}
