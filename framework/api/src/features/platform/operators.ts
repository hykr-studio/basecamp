// The platform's operators (B19): named, signed-in people, each with operator capabilities
// (`platform.*`). The guard reads the operator row from the session on every request; no header,
// role or body ever makes someone an operator.
import {
  CHANNEL_HEADER,
  type Operator,
  type OperatorCapabilityDef,
  operatorCapabilities,
  type Principal,
} from '@hykr/contracts';
import {
  type ApiRequest,
  CORE_OPTIONS,
  type CoreOptions,
  header,
  systemPrincipal,
} from '@hykr/core';
import { type Database, type DbOrTx, platformOperators, user, writeAudit } from '@hykr/db';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, isNull, sql } from 'drizzle-orm';

/** An operator as the guard found them: enabled, holding the capabilities that exist. */
export type ActingOperator = { id: string; userId: string; capabilities: string[] };

export type OperatorRequest = ApiRequest & { operator?: ActingOperator };

/** The enabled operator this account is, if any. Unknown capabilities are dropped. */
export async function operatorOf(db: DbOrTx, userId: string): Promise<ActingOperator | undefined> {
  const [row] = await db
    .select({ id: platformOperators.id, capabilities: platformOperators.capabilities })
    .from(platformOperators)
    .where(and(eq(platformOperators.userId, userId), isNull(platformOperators.disabledAt)));
  if (!row) return undefined;
  return {
    id: row.id,
    userId,
    capabilities: row.capabilities.filter((c) => operatorCapabilities.has(c)).sort(),
  };
}

const NEEDS = 'platform:operator-capability';

/** What an operator route needs, besides being an operator. */
export const OperatorCan = (capability: OperatorCapabilityDef) =>
  SetMetadata(NEEDS, capability.name);

/**
 * Operator routes: a person, signed in, calling on their own (no agent key, no channel but the
 * app: software acting for a person never acts as an operator), who is an enabled operator holding
 * what the route needs. Unknown session 401; no operator 403 `not_an_operator`; without the
 * capability 403 `operator_capability`. Pair it with @OptionalAuth().
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<OperatorRequest>();
    const channel = header(req, CHANNEL_HEADER);
    if (header(req, 'x-agent-key') || (channel !== undefined && channel !== 'app'))
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'humans_only',
        reason: 'Only an operator, signed in, can do this',
      });
    const userId = req.session?.user?.id;
    if (!userId) throw new UnauthorizedException();
    const operator = await operatorOf(this.options.db, userId);
    if (!operator)
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'not_an_operator',
        reason: 'This is for the platform’s operators',
      });
    const needs = this.reflector.getAllAndOverride<string | undefined>(NEEDS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (needs && !operator.capabilities.includes(needs))
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'operator_capability',
        reason: `This needs the operator capability ${needs}`,
      });
    req.operator = operator;
    return true;
  }
}

export const CurrentOperator = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const operator = ctx.switchToHttp().getRequest<OperatorRequest>().operator;
  if (!operator) throw new Error('CurrentOperator used on a route without OperatorGuard');
  return operator;
});

/**
 * An operator's action in one business: the server's own job there, on behalf of the operator,
 * so the business's audit shows the job and `on_behalf_of = operator:<id>`.
 */
export function operatorPrincipal(
  tenantId: string,
  job: string,
  operator: Pick<ActingOperator, 'id'>,
): Principal {
  return systemPrincipal({
    tenantId,
    job,
    channel: 'api',
    onBehalfOf: { kind: 'operator', operatorId: operator.id },
  });
}

/** Operators with their account's name and email. */
export async function listOperators(db: DbOrTx, id?: string): Promise<Operator[]> {
  const rows = await db
    .select({ o: platformOperators, name: user.name, email: user.email })
    .from(platformOperators)
    .innerJoin(user, eq(user.id, platformOperators.userId))
    .where(id ? eq(platformOperators.id, id) : undefined)
    .orderBy(platformOperators.createdAt);
  return rows.map(({ o, name, email }) => ({
    id: o.id,
    userId: o.userId,
    name,
    email,
    capabilities: o.capabilities,
    note: o.note,
    createdAt: o.createdAt.toISOString(),
    disabledAt: o.disabledAt?.toISOString() ?? null,
  }));
}

/** Operator capabilities nobody defines, among these. */
export const unknownOperatorCapabilities = (names: readonly string[]) =>
  names.filter((n) => !operatorCapabilities.has(n));

/**
 * Make the account with this email an operator holding these capabilities (or enable them again,
 * with these), or disable them: the deployment's first operators, from server code and the
 * command line (`basecamp operator`). Audited as the system job `cli.operators`. Returns the id.
 */
export async function saveOperator(
  db: Database,
  a: { email: string; capabilities?: readonly string[]; disable?: boolean; by?: string },
): Promise<string> {
  const capabilities = [
    ...new Set(a.capabilities ?? operatorCapabilities.all().map((c) => c.name)),
  ];
  const unknown = unknownOperatorCapabilities(capabilities);
  if (unknown.length) throw new Error(`No operator capability ${unknown.join(', ')}`);
  return db.transaction(async (tx) => {
    const found = await tx
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(${user.email}) = ${a.email.toLowerCase()}`)
      .limit(2);
    if (found.length !== 1) throw new Error(`No account has the email ${a.email}`);
    const userId = found[0].id;
    const [before] = await tx
      .select()
      .from(platformOperators)
      .where(eq(platformOperators.userId, userId))
      .for('update');
    if (a.disable && !before) throw new Error(`${a.email} is no operator`);
    const [row] = before
      ? await tx
          .update(platformOperators)
          .set(
            a.disable
              ? { disabledAt: before.disabledAt ?? new Date() }
              : { capabilities: capabilities.sort(), disabledAt: null },
          )
          .where(eq(platformOperators.id, before.id))
          .returning()
      : await tx
          .insert(platformOperators)
          .values({ userId, capabilities: capabilities.sort(), addedBy: a.by ?? 'cli' })
          .returning();
    const json = (r: typeof row | undefined) =>
      r && {
        id: r.id,
        userId: r.userId,
        capabilities: r.capabilities,
        disabledAt: r.disabledAt?.toISOString() ?? null,
      };
    await writeAudit(tx, {
      actorKind: 'system',
      actorId: 'cli.operators',
      channel: 'background',
      action: a.disable
        ? 'platform.operators.disable'
        : before
          ? 'platform.operators.update'
          : 'platform.operators.add',
      resourceType: 'operator',
      resourceId: row.id,
      before: json(before) ?? null,
      after: json(row),
      rule: 'server_code',
      reason: 'The deployment set an operator',
    });
    return row.id;
  });
}
