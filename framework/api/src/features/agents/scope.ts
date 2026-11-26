// An agent's scope: the tools its model gets, and, server side, what its run token reaches. A run
// acts for its owner (their roles, as they are now); its scope only ever takes from that.
import {
  AGENT_RUN_HEADER,
  agentToolIds,
  CANVAS_TOOLS,
  type Catalog,
  commandToolId,
  type Principal,
} from '@hykr/contracts';
import { type ApiRequest, deny, type WriteHook } from '@hykr/core';
import { toolsFor } from '@hykr/core/tools';
import {
  type CallHandler,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { runtime } from '../../runtime.js';

/** Every run token's principal carries this scope; the checks below apply only to them. */
export const RUN_SCOPE = 'agent-run';
const READ = 'agent-run.read:';
const WRITE = 'agent-run.write:';

/** Is this principal a run of one of the business's agents? */
export const isAgentRun = (p: Principal | undefined): boolean => !!p?.scopes.includes(RUN_SCOPE);

/** May this run read the entity (by name)? */
export const mayRead = (p: Principal, entity: string) => p.scopes.includes(`${READ}${entity}`);
/** May this run make the write (its operation's name: 'task.create', 'meeting.close')? */
export const mayWrite = (p: Principal, op: string) => p.scopes.includes(`${WRITE}${op}`);

/** The tools no agent's scope may hold: the agents' own and the canvas's. */
export const unscoped = (): ReadonlySet<string> => new Set([...agentToolIds(), ...CANVAS_TOOLS]);

let toolIds: readonly string[] | undefined;

/** Every tool id the assistant has here (generated and contributed), built once per process. */
export function allToolIds(): readonly string[] {
  if (toolIds) return toolIds;
  const { catalog, registry } = runtime();
  const clientFor = () => {
    throw new Error('Tools listed for agents are never called');
  };
  toolIds = Object.keys(toolsFor({ clientFor, registry }, catalog, { canvas: true }));
  return toolIds;
}

/** The tools an agent's run must not get: every tool outside its scope. */
export function toolsOutside(scope: readonly string[]): string[] {
  const kept = new Set(scope.filter((t) => !unscoped().has(t)));
  return allToolIds().filter((id) => !kept.has(id));
}

/**
 * What a run's token reaches, from the tools in its scope: a generated entity tool reads its
 * entity (a write tool also writes with its operation), a command's tool runs that command. A
 * contributed tool adds nothing here: it reads through its own route, still as the owner.
 */
export function scopesFor(tools: readonly string[], catalog: Catalog): string[] {
  const out = new Set<string>([RUN_SCOPE]);
  const held = new Set(tools.filter((t) => !unscoped().has(t)));
  for (const spec of Object.values(catalog.entities)) {
    if (spec.name === 'agent') continue;
    const reads = [`list-${spec.plural}`, `summarize-${spec.plural}`, `get-${spec.name}`];
    if (reads.some((t) => held.has(t))) out.add(`${READ}${spec.name}`);
    for (const action of ['create', 'update', 'delete'] as const)
      if (held.has(`${action}-${spec.name}`)) {
        out.add(`${READ}${spec.name}`);
        out.add(`${WRITE}${spec.name}.${action}`);
      }
  }
  for (const c of catalog.commands) {
    const id = commandToolId(c);
    if (id && held.has(id) && !c.name.startsWith('agent.')) out.add(`${WRITE}${c.name}`);
  }
  return [...out];
}

/** The entities a scope reads, by name: what a condition may watch. */
export function readableIn(tools: readonly string[], catalog: Catalog): Set<string> {
  return new Set(
    scopesFor(tools, catalog)
      .filter((s) => s.startsWith(READ))
      .map((s) => s.slice(READ.length)),
  );
}

/**
 * Every write a run makes passes here: an operation outside its scope is refused (audited as
 * denied), and an agent run never writes agents.
 */
export const AgentScopeHook: WriteHook = {
  name: 'agents.scope',
  decide: ({ ctx, op }) => {
    const p = ctx.principal;
    if (!isAgentRun(p)) return null;
    const name = String(op.name);
    if (name.startsWith('agent.') || !mayWrite(p, name))
      return deny('agent_scope', `This agent's scope does not let it ${name}`);
    return null;
  },
};

/** The framework's routes an agent run never calls. */
const OFF_LIMITS = new Set(['agents', 'agent-runs', 'agent-templates']);

/**
 * Reads, at the door: a run token's request to an entity's routes (`/api/<plural>…`) needs the
 * entity in its scope; the agents' own routes are closed to it. Everything else is the routes'
 * own guards, as the owner.
 */
@Injectable()
export class AgentScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const p = req.principal;
    if (!isAgentRun(p) || !p) return next.handle();
    const [api, segment] = req.path.split('/').filter(Boolean);
    if (api !== 'api' || !segment) return next.handle();
    const refuse = (reason: string) =>
      new ForbiddenException({ error: 'forbidden', rule: 'agent_scope', reason });
    if (OFF_LIMITS.has(segment)) throw refuse('An agent run cannot manage agents');
    const spec = Object.values(runtime().catalog.entities).find((s) => s.plural === segment);
    if (spec && (req.method === 'GET' || req.method === 'HEAD') && !mayRead(p, spec.name))
      throw refuse(`This agent's scope does not let it read ${spec.plural}`);
    return next.handle();
  }
}

/** The run token's header, for logs and tests. */
export { AGENT_RUN_HEADER };
