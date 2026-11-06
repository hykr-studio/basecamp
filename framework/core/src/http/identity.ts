import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Channel, parseSubjectKey, TURN_CHANNELS, type TurnChannel } from '@hykr/contracts';
import { UnauthorizedException } from '@nestjs/common';
import {
  type AgentIdentity,
  type AgentIdentityProvider,
  type IdentityRequest,
  identityProviders,
} from '../hooks.js';
import type { AgentKey } from '../tokens.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** A run id names a trace and audit rows: short, and safe to log. */
export const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** An agent's id, as audited: 'assistant', 'mcp:claude'. */
const AGENT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

const headerOf = (req: IdentityRequest, name: string) => {
  const value = req.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const isTurnChannel = (value: string | undefined): value is TurnChannel =>
  (TURN_CHANNELS as readonly string[]).includes(value ?? '');

/**
 * The agents configured with a key (the assistant, the voice worker): x-agent-key names the
 * agent, x-agent-id must match it, x-acting-for names whom it acts for and x-run-id its run.
 * Always the first provider. A wrong key never falls through to anything else.
 */
export function agentKeyProvider(agents: readonly AgentKey[]): AgentIdentityProvider {
  return {
    name: 'agent-key',
    async identify(req) {
      const agentKey = headerOf(req, 'x-agent-key');
      if (!agentKey) return null;
      // Hash both sides: equal lengths for timingSafeEqual, and nothing leaks the key's length.
      const presented = sha256(agentKey);
      const agent = agents.find(
        (a) => a.key.length > 0 && timingSafeEqual(presented, sha256(a.key)),
      );
      if (!agent) throw new UnauthorizedException('invalid agent key');
      if (headerOf(req, 'x-agent-id') !== agent.id)
        throw new UnauthorizedException('unknown agent');
      const actingFor = headerOf(req, 'x-acting-for');
      const runId = headerOf(req, 'x-run-id');
      if (!actingFor || !runId)
        throw new UnauthorizedException('agent requests need x-acting-for and x-run-id');
      if (!RUN_ID.test(runId)) throw new UnauthorizedException('x-run-id is not a run id');
      const subject = parseSubjectKey(actingFor);
      if (!subject) throw new UnauthorizedException('x-acting-for names nobody we know');
      // A relay's channel is fixed by its key; the assistant forwards the channel of the turn
      // it is running, and only a turn's channel (never 'background', 'share' or free text).
      const forwarded = headerOf(req, 'x-channel');
      const channel = agent.channel ?? (isTurnChannel(forwarded) ? forwarded : undefined);
      return {
        agentId: agent.id,
        actingFor:
          subject.kind === 'user' ? { userId: subject.userId } : { contactId: subject.contactId },
        runId,
        agentVersion: headerOf(req, 'x-agent-version'),
        ...(channel ? { channel } : {}),
        ...(agent.relay ? { relay: true } : {}),
      };
    },
  };
}

/**
 * Who the calling agent is, asking each provider in turn: the agent key first, then every
 * contributed provider in registration order. null: no agent credential at all (a session,
 * or nobody). An identity is checked before it is used: a contributed provider can never
 * pass as a configured agent, it names exactly one person or contact, a run id is well formed
 * (one is made when the credential has none), and its channel is a known one.
 */
export async function identifyAgent(
  req: IdentityRequest,
  keyed: AgentIdentityProvider,
  reservedIds: readonly string[],
): Promise<AgentIdentity | null> {
  for (const provider of [keyed, ...identityProviders.all()]) {
    const identity = await provider.identify(req);
    if (!identity) continue;
    const contributed = provider !== keyed;
    const bad = (why: string) => new UnauthorizedException(`${provider.name}: ${why}`);
    if (!AGENT_ID.test(identity.agentId ?? '')) throw bad('not an agent id');
    if (contributed && reservedIds.includes(identity.agentId))
      throw bad(`"${identity.agentId}" is a configured agent's id`);
    const { userId, contactId } = identity.actingFor ?? {};
    if (!userId === !contactId) throw bad('it must act for one person or one contact');
    if (identity.runId !== undefined && !RUN_ID.test(identity.runId)) throw bad('not a run id');
    if (identity.channel !== undefined && !Channel.safeParse(identity.channel).success)
      throw bad('not a channel');
    return {
      ...identity,
      actingFor: userId ? { userId } : { contactId },
      runId: identity.runId ?? randomUUID(),
    };
  }
  return null;
}
