import { type AgentDomain, type Agents, createAgents, mergeAgentModules } from '@hykr/agents';
import {
  type Catalog,
  type Contributions,
  createCatalog,
  installContributions,
  ModulesError,
  mergeContributions,
} from '@hykr/contracts';
import type { MigrationSet } from '@hykr/db';
import { type Labels, overridePhrases, type PhraseOverrides } from '@hykr/i18n';
import {
  createNotificationCatalog,
  type NotificationCatalog,
  type NotificationOverride,
} from '@hykr/notifications';
import { createUiRegistry, type Registry } from '@hykr/ui-registry';
import type { ModuleDef } from './module.js';
import { crossProblems, tableProblems } from './module-checks.js';
// The registries every contribution key goes to: loaded before any app is installed.
import './hooks.js';

/**
 * Everything an application gives the server: its name, who its assistant is, and its modules
 * (each with its entities, commands, Nest module, views, notifications and agent part). The
 * framework never imports an application; the application passes this in.
 */
export interface ServerDefinition {
  /** What the product calls itself: "Meetings". */
  name: string;
  /** First line of the assistant's instructions: who it is. One for the whole application. */
  persona: string;
  /** The scripted model's answer when no script matches. Default: the modules' help lines. */
  help?: string;
  /** On WhatsApp: what the assistant helps with, one sentence per language (welcome, HELP). */
  channel?: { does: Labels };
  /**
   * The application's modules (`defineModule`), in dependency order: a module comes after the
   * modules it depends on. An earlier module's scripted-model scripts match first.
   */
  modules: readonly ModuleDef[];
  /** The application's migrations, applied after the framework's (`basecamp db migrate`). */
  migrations?: MigrationSet[];
  /**
   * Hooks and plugins the application adds, by kind (see `Contributions` in @hykr/contracts
   * and the registries in hooks.ts), after the modules' own. Installed once, when the process
   * starts serving it.
   */
  contributes?: Partial<Contributions>;
  /**
   * Put before every module's table names, when two applications share one database (the
   * framework's test fixture uses 'fixture_'). Default: none, so the `orders` module's tables
   * are `orders` and `orders_…`.
   */
  tablePrefix?: string;
  /**
   * The application's own words for what the framework says and sends (A11): framework phrases
   * (`phrases`, installed when the process starts serving it) and rewordings of declared
   * notifications (`overrideNotification`). A business may word them again in its settings.
   */
  wording?: {
    phrases?: PhraseOverrides;
    notifications?: readonly NotificationOverride[];
  };
}

/** An application as the server runs it: its definition, built into the framework's parts. */
export interface Basecamp {
  definition: ServerDefinition;
  catalog: Catalog;
  registry: Registry;
  notifications: NotificationCatalog;
  /** What the assistant knows: the persona and the modules' rules, scripts and evals. */
  agentDomain: AgentDomain;
  /** Everything it contributes, merged: installed into the registries by `setRuntime`. */
  contributions: Partial<Contributions>;
  /** The assistant, built on first use (the templates CLI and migrations never need it). */
  readonly agents: Agents;
}

/** Run a merge, keeping its problems instead of stopping at the first part that fails. */
function collect<T>(problems: string[], build: () => T): T | undefined {
  try {
    return build();
  } catch (error) {
    if (error instanceof ModulesError) problems.push(...error.problems);
    else if (error instanceof Error && error.message.startsWith('Modules do not fit together:'))
      problems.push(...error.message.split('\n- ').slice(1));
    else throw error;
    return undefined;
  }
}

/**
 * The application, merged from its modules and checked once: every collision between modules
 * (and with the framework) throws one ModulesError that lists them all, before anything serves.
 */
export function defineServer(definition: ServerDefinition): Basecamp {
  const { modules } = definition;
  const problems: string[] = [];
  const catalog = collect(problems, () => createCatalog(...modules));
  const registry = collect(problems, () =>
    createUiRegistry(...modules.map((m) => ({ name: m.name, views: m.views, screens: m.screens }))),
  );
  const notifications = collect(problems, () =>
    createNotificationCatalog(
      ...modules.map((m) => ({ templates: m.templates, notifications: m.notifications })),
      { overrides: definition.wording?.notifications },
    ),
  );
  problems.push(...tableProblems(modules, definition.tablePrefix));
  if (catalog && registry) problems.push(...crossProblems({ modules, catalog, registry }));
  if (problems.length || !catalog || !registry || !notifications) throw new ModulesError(problems);

  const agentDomain = mergeAgentModules(definition, modules);
  let agents: Agents | undefined;
  return {
    definition,
    catalog,
    registry,
    notifications,
    agentDomain,
    contributions: mergeContributions(...modules.map((m) => m.contributes), definition.contributes),
    get agents() {
      agents ??= createAgents({ catalog, registry, domain: agentDomain });
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

/** Serve this application in this process, and install its contributions into the registries. */
export function setRuntime(app: Basecamp) {
  if (current === app) return;
  if (current) throw new Error('Another application is already registered');
  installContributions(app.contributions);
  if (app.definition.wording?.phrases) overridePhrases(app.definition.wording.phrases);
  current = app;
}
