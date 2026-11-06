import { randomUUID } from 'node:crypto';
import { type CapabilityDef, capabilities, type Principal } from '@hykr/contracts';
import { RUN_ID } from './http/identity.js';

/** A job's name, as audited (the actor id): lower case and dotted, 'sla.sweeper'. */
const JOB = /^[a-z][a-z0-9_.-]{0,63}$/;

export interface SystemPrincipalOptions {
  /** The one business it works in. Every scoped query still starts here. */
  tenantId: string;
  /** What runs, as audit names it: 'sla.sweeper', 'leads.route'. */
  job: string;
  /** Ties together the rows one run writes. Default: a new id. */
  runId?: string;
  /** What it may do besides reaching its business's rows. Default: nothing. */
  capabilities?: readonly (string | CapabilityDef)[];
}

/**
 * The server's own background work as a principal (a sweeper, a timer, an inbound webhook's
 * job), so it writes through `runWrite` like everyone else: validated, checked by entity rules
 * and approval rules, and audited as actor `system`, channel `background`. It reaches every row
 * of its one business and nothing outside it. Server code only: no request header or body
 * ever becomes one, and PrincipalGuard never makes one.
 *
 * It cannot create an entity row (a new row needs an owner) or park (nobody would decide):
 * both are refused for now (decisions F4).
 */
export function systemPrincipal(options: SystemPrincipalOptions): Principal {
  const { tenantId, job } = options;
  if (!tenantId) throw new Error('systemPrincipal needs the business it works in');
  if (!JOB.test(job)) throw new Error(`systemPrincipal: "${job}" is not a job name`);
  const runId = options.runId ?? randomUUID();
  if (!RUN_ID.test(runId)) throw new Error(`systemPrincipal: "${runId}" is not a run id`);
  const names = (options.capabilities ?? []).map((c) => (typeof c === 'string' ? c : c.name));
  for (const name of names)
    if (!capabilities.has(name)) throw new Error(`systemPrincipal: unknown capability "${name}"`);
  return {
    actor: { kind: 'system', id: job },
    tenantId,
    roles: [],
    capabilities: [...new Set(names)].sort(),
    assurance: 'session',
    scopes: [],
    runId,
    channel: 'background',
  };
}
