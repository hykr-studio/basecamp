import { randomUUID } from 'node:crypto';
import {
  type CapabilityDef,
  type Channel,
  capabilities,
  OnBehalfOf,
  type Principal,
} from '@hykr/contracts';
import { RUN_ID } from './http/identity.js';

/** A job's name, as audited (the actor id): lower case and dotted, 'reminders.sweep'. */
const JOB = /^[a-z][a-z0-9_.-]{0,63}$/;

export interface SystemPrincipalOptions {
  /** The one business it works in. Every scoped query still starts here. */
  tenantId: string;
  /** What runs, as audit names it: 'reminders.sweep', 'requests.route'. */
  job: string;
  /** Ties together the rows one run writes. Default: a new id. */
  runId?: string;
  /** What it may do besides reaching its business's rows. Default: nothing. */
  capabilities?: readonly (string | CapabilityDef)[];
  /**
   * The business's customer it works for (a routed request's sender): a row it creates gets
   * this customer. Server code makes sure the customer is this business's.
   */
  customerId?: string;
  /** Done for a platform operator (B19): audited as `on_behalf_of`. */
  onBehalfOf?: OnBehalfOf;
  /** How the work reached the server. Default `background`; an operator's action is `api`. */
  channel?: Extract<Channel, 'background' | 'api'>;
}

/**
 * The server's own background work as a principal (a sweeper, a timer, an inbound webhook's
 * job), so it writes through `runWrite` like everyone else: validated, checked by entity rules
 * and approval rules, and audited as actor `system`, channel `background`. It reaches every row
 * of its one business and nothing outside it. Server code only: no request header or body
 * ever becomes one, and PrincipalGuard never makes one.
 *
 * A row it creates is owned by the business's default owner (and gets `customerId`, when given
 * and the table has a customer column). It cannot park (nobody would decide): refused (409,
 * decisions F4).
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
    channel: options.channel ?? 'background',
    ...(options.customerId ? { customerId: options.customerId } : {}),
    ...(options.onBehalfOf ? { onBehalfOf: OnBehalfOf.parse(options.onBehalfOf) } : {}),
  };
}
