// Platform scope (B19): the platform's own business (PLATFORM_TENANT_ID, A11) keeps the shared
// records every business reads. An operator holding `platform.shared` works there without being a
// member, with the business capability `shared.publish` only; a shared entity whose access names
// that capability lets them maintain its rows. An entity whose trait says `publishers:
// 'operators'` has its platform rows written only at platform scope.
import {
  type EntitySpec,
  PlatformCapabilities,
  type Principal,
  SharedPublishCapability,
} from '@hykr/contracts';
import {
  deny,
  type EntityPlugin,
  entityDef,
  isShared,
  platformTenantId,
  RuleDenied,
  type StandingProvider,
  type WriteHook,
} from '@hykr/core';
import { operatorOf } from './operators.js';

/** Channels sure enough of the person: signed in (never a number alone, nor a link). */
const SESSION_CHANNELS = new Set([undefined, 'app', 'api', 'voice', 'mcp', 'webmcp']);

/** An operator holding `platform.shared`, asking for the platform's business: platform scope. */
export const platformScopeStanding: StandingProvider = {
  name: 'platform-scope',
  async forUser({ db, userId, tenantId, channel }) {
    const platform = platformTenantId();
    if (!platform || tenantId !== platform || !SESSION_CHANNELS.has(channel)) return null;
    const operator = await operatorOf(db, userId);
    if (!operator?.capabilities.includes(PlatformCapabilities.shared.name)) return null;
    return {
      roles: [],
      capabilities: [SharedPublishCapability.name],
      standing: 'operator',
      onBehalfOf: { kind: 'operator', operatorId: operator.id },
    };
  },
};

/** Are this entity's platform rows written only at platform scope? */
const operatorsOnly = (spec: EntitySpec) =>
  isShared(spec) && spec.traits?.shared?.publishers === 'operators';

/** Refused when p writes the platform's rows of such an entity without platform scope. */
function refusal(p: Principal) {
  const platform = platformTenantId();
  if (!platform || p.tenantId !== platform) return null;
  if (p.actor.kind === 'system' || p.onBehalfOf?.kind === 'operator') return null;
  return deny(
    'platform_scope_only',
    "The platform's shared records are published by the platform's operators",
  );
}

/** On the CRUD path: refused before anything is written. */
export const platformScopePlugin: EntityPlugin = {
  name: 'platform-scope',
  appliesTo: operatorsOnly,
  decide: (p) => refusal(p),
};

/** On every other path (a command's repository calls): the write rolls back, audited as refused. */
export const platformScopeHook: WriteHook = {
  name: 'platform-scope',
  async afterRun({ ctx, touched }) {
    const refused = refusal(ctx.principal);
    if (!refused) return;
    for (const t of touched) {
      const def = entityDef(t.type);
      if (def && operatorsOnly(def.spec)) throw new RuleDenied(refused);
    }
  },
};
