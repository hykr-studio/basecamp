import { assertNoProblems, MODULE_NAME, PLATFORM_MODULE, stampModule } from './framework/module.js';
import { referenceProblems } from './framework/references.js';
import type { CommandSpec, EntitySpec, WriteAction } from './framework/spec.js';
import { platformCommands, platformEntities } from './platform/index.js';

/**
 * Every entity and command the system serves: the application's modules plus the framework's
 * own. Derived lists (API history, agent tools, the app's data hooks) read from a catalog;
 * the framework never imports an application, the application passes its modules in.
 */
export interface Catalog<E extends Record<string, EntitySpec> = Record<string, EntitySpec>> {
  entities: E & typeof platformEntities;
  commands: readonly CommandSpec[];
  /** Entity names as audited ('todo', 'page'): the resource types history can show. */
  entityNames: [string, ...string[]];
  entityByName(name: string): EntitySpec | undefined;
  commandByName(name: string): CommandSpec | undefined;
  /** The application's modules, in order (the framework's own is not listed). */
  modules: readonly CatalogModule[];
  /**
   * The module that declares an entity (by name or plural) or a command (by name): 'todos',
   * or 'platform' for the framework's own. Undefined when nothing has that name.
   */
  moduleOf(name: string): string | undefined;
  /** The module whose entity or command a tool id belongs to ('create-todo' → 'todos'). */
  toolModule(toolId: string): string | undefined;
  /** Every tool id the catalog gives the agent, the canvas tools included. */
  toolIds: readonly string[];
}

/** One module, as the catalog lists it. */
export interface CatalogModule {
  name: string;
  dependsOn: readonly string[];
  /** Entity names ('todo'). */
  entities: readonly string[];
  /** Command names ('meeting.close'). */
  commands: readonly string[];
}

/** What createCatalog takes per module: a `moduleSpec`, or any `{ name, entities, commands }`. */
export interface CatalogPart<
  E extends Record<string, EntitySpec> = Record<string, EntitySpec>,
  C extends readonly CommandSpec[] = readonly CommandSpec[],
> {
  name: string;
  dependsOn?: readonly string[];
  entities: E;
  commands: C;
}

type Intersect<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void
  ? I
  : never;
/** The entities of several parts as one map type, so `catalog.entities.todos` stays typed. */
export type EntitiesOf<P extends readonly CatalogPart[]> = [P[number]] extends [never]
  ? Record<never, EntitySpec>
  : Intersect<P[number]['entities']> extends infer E extends Record<string, EntitySpec>
    ? E
    : Record<string, EntitySpec>;

// The framework's own specs belong to the platform module.
for (const spec of Object.values(platformEntities)) stampModule(spec, PLATFORM_MODULE);
for (const spec of platformCommands) stampModule(spec, PLATFORM_MODULE);

/**
 * The first path segments under /api/ the framework serves itself: no module's entity plural or
 * command path may use them. A framework feature with its own controller under /api/<x> reserves
 * <x> with `reserveRoutes` in a file its package loads before any application is defined.
 */
const reserved = new Set([
  'approvals',
  'auth',
  'backoffice',
  'channels',
  'chat',
  'handoff',
  'history',
  'me',
  'notify',
  'pages',
  'threads',
  'voice',
]);

/** Reserve first path segments under /api/ for the framework ('files' for /api/files/...). */
export function reserveRoutes(...segments: string[]) {
  for (const segment of segments) {
    if (!/^[a-z0-9-]+$/.test(segment)) throw new Error(`Bad route segment "${segment}"`);
    reserved.add(segment);
  }
}

/** The reserved first segments under /api/. */
export const reservedRoutes = (): ReadonlySet<string> => reserved;

/** The canvas tools' ids: the agent has them wherever a canvas exists. */
export const CANVAS_TOOLS = ['canvas-open', 'canvas-compose', 'canvas-patch'] as const;

/**
 * The tool ids an entity gives the agent (only its actions exposed to everyone): the CRUD tools,
 * then, with the list, `summarize-<plural>` (counts and totals).
 */
export function entityToolIds(spec: EntitySpec): string[] {
  const exposed = (a: keyof EntitySpec['expose']) => spec.expose[a] === 'all';
  return [
    ...(exposed('list') ? [`list-${spec.plural}`] : []),
    ...(['get', 'create', 'update', 'delete'] as const)
      .filter(exposed)
      .map((a) => `${a}-${spec.name}`),
    ...(exposed('list') ? [`summarize-${spec.plural}`] : []),
  ];
}

/** The tool id a command gives the agent, if it has one. */
export const commandToolId = (spec: CommandSpec): string | undefined =>
  spec.tool && spec.expose === 'all' ? spec.tool : undefined;

const WRITES: readonly WriteAction[] = ['create', 'update', 'delete'];

/** `/api/meetings/:meetingId/close` → ['api', 'meetings', ':', 'close']. */
function routeOf(path: string): string[] {
  const rest = path.replace(/^\/+/, '').replace(/^api\//, '');
  return ['api', ...rest.split('/').filter(Boolean)].map((s) => (s.startsWith(':') ? ':' : s));
}

/** Two routes of one method collide when every segment matches (a param matches anything). */
const overlaps = (a: string[], b: string[]) =>
  a.length === b.length && a.every((s, i) => s === b[i] || s === ':' || b[i] === ':');

type Route = { method: string; segments: string[]; owner: string };

/** The routes an entity serves: GET/POST /api/<plural>, GET/PATCH/DELETE /api/<plural>/:id. */
function entityRoutes(spec: EntitySpec, owner: string): Route[] {
  const served = (a: keyof EntitySpec['expose']) => spec.expose[a] !== 'internal';
  const list = ['api', spec.plural];
  const one = ['api', spec.plural, ':'];
  return [
    ...(served('list') ? [{ method: 'GET', segments: list, owner }] : []),
    ...(served('create') ? [{ method: 'POST', segments: list, owner }] : []),
    ...(served('get') ? [{ method: 'GET', segments: one, owner }] : []),
    ...(served('update') ? [{ method: 'PATCH', segments: one, owner }] : []),
    ...(served('delete') ? [{ method: 'DELETE', segments: one, owner }] : []),
  ];
}

/**
 * The catalog of one or more modules, plus the framework's own entities and commands. Throws a
 * ModulesError listing every collision instead of letting a later module replace an earlier
 * one: entity names and plurals, command names, approval op names, tool ids, routes (and the
 * framework's own), `touches`, module names and `dependsOn` (a module comes after the modules it
 * depends on). The server and the apps build theirs the same way, so both see the same errors.
 */
export function createCatalog<const P extends readonly CatalogPart[]>(
  ...parts: P
): Catalog<EntitiesOf<P>> {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  /** First come, first served; a second claim is a problem. */
  const claim = (kind: string, key: string, module: string) => {
    const taken = owners.get(`${kind}:${key}`);
    if (taken === undefined) {
      owners.set(`${kind}:${key}`, module);
      return true;
    }
    problems.push(
      taken === module
        ? `${module} declares the ${kind} ${key} twice`
        : `The ${kind} ${key} is declared by both ${taken} and ${module}`,
    );
    return false;
  };

  const all = [
    ...parts.map((p) => ({
      module: p.name,
      entities: Object.values(p.entities) as EntitySpec[],
      commands: p.commands,
    })),
    {
      module: PLATFORM_MODULE,
      entities: Object.values(platformEntities) as EntitySpec[],
      commands: platformCommands,
    },
  ];
  const own = (module: string) => module !== PLATFORM_MODULE;
  /** A spec stamped by another module (a part that is a module, not a legacy domain). */
  const misplaced = (spec: EntitySpec | CommandSpec, module: string) =>
    spec.module !== undefined && spec.module !== module && MODULE_NAME.test(module);

  // Modules: unique names, each after the modules it depends on.
  const seen: string[] = [];
  for (const part of parts) {
    if (part.name === PLATFORM_MODULE)
      problems.push(`"${PLATFORM_MODULE}" is the framework's own module name`);
    else if (seen.includes(part.name)) problems.push(`The module ${part.name} is listed twice`);
    for (const dep of part.dependsOn ?? []) {
      if (dep === part.name) problems.push(`${part.name} cannot depend on itself`);
      else if (!parts.some((p) => p.name === dep))
        problems.push(`${part.name} depends on ${dep}, which is not one of the modules`);
      else if (!seen.includes(dep))
        problems.push(`${part.name} depends on ${dep}: list ${dep} before ${part.name}`);
    }
    seen.push(part.name);
    for (const [plural, spec] of Object.entries(part.entities))
      if (spec.plural !== plural)
        problems.push(
          `${part.name}: entity "${plural}" must be keyed by its plural (${spec.plural})`,
        );
  }

  // Entity names and plurals, the approval ops they register, and their routes.
  const routes: Route[] = [];
  const ops = new Map<string, string>();
  for (const { module, entities } of all) {
    for (const spec of entities) {
      if (misplaced(spec, module))
        problems.push(`The entity ${spec.name} belongs to ${spec.module}, not ${module}`);
      claim('entity', spec.name, module);
      if (claim('plural', spec.plural, module) && own(module) && reserved.has(spec.plural))
        problems.push(
          `${module}: the plural ${spec.plural} is a framework route (/api/${spec.plural})`,
        );
      for (const action of WRITES) ops.set(`${spec.name}.${action}`, module);
      routes.push(...entityRoutes(spec, `${module} ${spec.name}`));
    }
  }
  // Command names, which must not be an entity's op name, and their routes.
  for (const { module, commands } of all) {
    for (const spec of commands) {
      if (misplaced(spec, module))
        problems.push(`The command ${spec.name} belongs to ${spec.module}, not ${module}`);
      claim('command', spec.name, module);
      const op = ops.get(spec.name);
      if (op !== undefined)
        problems.push(
          `${module}: the command ${spec.name} has the name of an entity action of ${op} (approvals replay by name)`,
        );
      const segments = routeOf(spec.http.path);
      if (own(module) && reserved.has(segments[1] ?? ''))
        problems.push(
          `${module}: the command ${spec.name} uses /api/${segments[1]}, a framework route`,
        );
      routes.push({ method: spec.http.method, segments, owner: `${module} ${spec.name}` });
    }
  }
  for (const [i, a] of routes.entries())
    for (const b of routes.slice(i + 1))
      if (a.method === b.method && overlaps(a.segments, b.segments))
        problems.push(
          `${a.method} /${a.segments.join('/')} (${a.owner}) and /${b.segments.join('/')} (${b.owner}) are the same route`,
        );

  // Tool ids: the agent gets one flat set, so each id names one tool.
  const tools = new Map<string, string>(CANVAS_TOOLS.map((id) => [id, PLATFORM_MODULE]));
  const tool = (id: string, module: string, what: string) => {
    const taken = tools.get(id);
    if (taken === undefined) tools.set(id, module);
    else problems.push(`The tool ${id} (${module} ${what}) is also a tool of ${taken}`);
  };
  for (const { module, entities, commands } of all) {
    for (const spec of entities)
      for (const id of entityToolIds(spec)) tool(id, spec.module ?? module, spec.name);
    for (const spec of commands) {
      const id = commandToolId(spec);
      if (id) tool(id, spec.module ?? module, spec.name);
    }
  }

  // `touches` names the entities a command changes, so clients refresh exactly those.
  const names = new Set(all.flatMap((m) => m.entities.map((s) => s.name)));
  for (const { module, commands } of all)
    for (const spec of commands)
      for (const name of spec.touches ?? [])
        if (!names.has(name))
          problems.push(`${module}: the command ${spec.name} touches ${name}, which is no entity`);
  // A reference names an entity of the catalog, from a field a write sets (V2).
  for (const { entities } of all)
    for (const spec of entities) problems.push(...referenceProblems(spec, names));

  assertNoProblems(problems);

  const entities = Object.assign({}, ...parts.map((p) => p.entities), platformEntities);
  const commands: readonly CommandSpec[] = all.flatMap((m) => m.commands);
  const specs = Object.values(entities) as EntitySpec[];
  const moduleByName = new Map<string, string>();
  for (const { module, entities: list, commands: cmds } of all) {
    for (const spec of list) {
      moduleByName.set(spec.name, spec.module ?? module);
      moduleByName.set(spec.plural, spec.module ?? module);
    }
    for (const spec of cmds) moduleByName.set(spec.name, spec.module ?? module);
  }
  return {
    entities,
    commands,
    entityNames: specs.map((s) => s.name) as [string, ...string[]],
    entityByName: (name) => specs.find((s) => s.name === name),
    commandByName: (name) => commands.find((c) => c.name === name),
    modules: parts.map((p) => ({
      name: p.name,
      dependsOn: p.dependsOn ?? [],
      entities: (Object.values(p.entities) as EntitySpec[]).map((s) => s.name),
      commands: p.commands.map((c) => c.name),
    })),
    moduleOf: (name) => moduleByName.get(name),
    toolModule: (id) => tools.get(id),
    toolIds: [...tools.keys()],
  };
}
