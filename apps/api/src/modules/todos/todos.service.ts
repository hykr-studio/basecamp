import type {
  Approval,
  ApprovalStatus,
  AuthorizeResult,
  CreateTodoInput,
  Principal,
  Todo,
  UpdateTodoInput,
  WriteResult,
} from '@app/contracts';
import type { approvals, todoRepo, todos, WriteCtx } from '@app/db';
import { authorizeTodo, subjectOf, type TodoAction } from '@app/policy';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { RequestMeta } from '../../common/principal.js';
import { TODO_REPO } from '../../infra/db.module.js';

type TodoRepo = ReturnType<typeof todoRepo>;
type TodoRow = typeof todos.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

export function toTodo(row: TodoRow): Todo {
  return { id: row.id, title: row.title, done: row.done, dueOn: row.dueOn };
}

export function toApproval(row: ApprovalRow): Approval {
  const payload = row.payload as { summary?: string } | null;
  return {
    id: row.id,
    action: row.action,
    rule: row.rule,
    reason: row.reason,
    status: row.status as ApprovalStatus,
    summary: payload?.summary ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Who is writing and why it was allowed, for every audit row. */
function writeCtx(p: Principal, result: Pick<AuthorizeResult, 'rule' | 'reason'>): WriteCtx {
  return {
    actorKind: p.actor.kind,
    actorId: p.actor.id,
    actingFor: p.actingFor?.userId ?? null,
    runId: p.runId ?? null,
    agentVersion: p.agentVersion ?? null,
    rule: result.rule,
    reason: result.reason,
  };
}

/**
 * Every write takes one path: load the resource, authorize, then write with an
 * audit row, park it as an approval, or refuse it (and audit the refusal).
 */
@Injectable()
export class TodosService {
  constructor(@Inject(TODO_REPO) private readonly repo: TodoRepo) {}

  async list(p: Principal, meta: RequestMeta): Promise<Todo[]> {
    await this.allowOnly(p, 'todo.list', null, meta);
    const rows = await this.repo.listFor(this.subject(p));
    return rows.map(toTodo);
  }

  async create(p: Principal, input: CreateTodoInput, meta: RequestMeta): Promise<WriteResult> {
    const result = await this.allowOnly(p, 'todo.create', null, meta);
    const row = await this.repo.create(this.subject(p), input, writeCtx(p, result));
    return { status: 'done', todo: toTodo(row) };
  }

  async update(
    p: Principal,
    id: string,
    input: UpdateTodoInput,
    meta: RequestMeta,
  ): Promise<WriteResult> {
    const before = await this.load(p, id);
    const result = await this.allowOnly(p, 'todo.update', before, meta);
    const row = await this.repo.update(before.ownerId, before.id, input, writeCtx(p, result));
    if (!row) throw new NotFoundException(); // deleted since we loaded it
    return { status: 'done', todo: toTodo(row) };
  }

  async remove(p: Principal, id: string, meta: RequestMeta): Promise<WriteResult> {
    const before = await this.load(p, id); // scoped: 404 if not yours
    const result = await this.check(p, 'todo.delete', before, meta);
    const ctx = writeCtx(p, result);
    if (result.decision === 'needs_approval') {
      const approval = await this.repo.requestApproval(
        {
          ownerId: before.ownerId,
          action: 'todo.delete',
          rule: result.rule,
          reason: result.reason,
          resourceType: 'todo',
          resourceId: before.id,
          payload: { summary: `Delete "${before.title}"` },
        },
        ctx,
      );
      return { status: 'needs_approval', approval: toApproval(approval) };
    }
    await this.repo.remove(before.ownerId, before.id, ctx);
    return { status: 'done', todo: null };
  }

  /** Only reachable by people (HumanOnlyGuard), so the actor is the owner. */
  async pendingApprovals(p: Principal): Promise<Approval[]> {
    const rows = await this.repo.pendingApprovalsFor(p.actor.id);
    return rows.map(toApproval);
  }

  async decide(p: Principal, id: string, approve: boolean, _meta: RequestMeta): Promise<Approval> {
    // Scoped to the owner, like to-dos: someone else's approval id is a 404, not a 403.
    const approval = await this.repo.findApprovalFor(p.actor.id, id);
    if (!approval) throw new NotFoundException();
    if (approval.status !== 'pending') {
      throw new ConflictException({ error: 'already_decided', status: approval.status });
    }
    const ctx = writeCtx(p, {
      rule: 'owner_decides',
      reason: approve ? 'Owner approved the request' : 'Owner rejected the request',
    });
    const decided = await this.repo.decideApproval(approval, approve, ctx);
    return toApproval(decided);
  }

  private subject(p: Principal): string {
    const subject = subjectOf(p);
    if (!subject)
      throw new ForbiddenException({ error: 'forbidden', rule: 'agent_needs_acting_for' });
    return subject;
  }

  private async load(p: Principal, id: string): Promise<TodoRow> {
    const row = await this.repo.findFor(this.subject(p), id);
    if (!row) throw new NotFoundException();
    return row;
  }

  private async check(
    p: Principal,
    action: TodoAction,
    resource: TodoRow | null,
    meta: RequestMeta,
  ): Promise<AuthorizeResult> {
    const result = authorizeTodo(p, action, resource);
    if (result.decision === 'deny') {
      await this.repo.auditOnly(action, resource?.id ?? null, writeCtx(p, result));
      throw new ForbiddenException({
        error: 'forbidden',
        rule: result.rule,
        reason: result.reason,
        requestId: meta.requestId,
      });
    }
    return result;
  }

  /** For actions that cannot be parked: decideApproval only knows how to finish a delete. */
  private async allowOnly(
    p: Principal,
    action: TodoAction,
    resource: TodoRow | null,
    meta: RequestMeta,
  ): Promise<AuthorizeResult> {
    const result = await this.check(p, action, resource, meta);
    if (result.decision !== 'allow') {
      await this.repo.auditOnly(action, resource?.id ?? null, writeCtx(p, result));
      throw new ForbiddenException({
        error: 'forbidden',
        rule: result.rule,
        reason: result.reason,
      });
    }
    return result;
  }
}
