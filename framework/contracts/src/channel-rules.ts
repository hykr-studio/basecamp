import type { Principal } from './principal.js';
import type { Channel } from './voice.js';

/**
 * What a channel allows, beyond who is calling. The server applies these to every request
 * (`PrincipalGuard`, `HumanOnlyGuard`); a client names its channel in `x-channel`.
 */

/** The header a caller names its channel in. */
export const CHANNEL_HEADER = 'x-channel';

/**
 * The channels a signed-in browser may name for its own calls: the app itself, and the page's
 * WebMCP tools. Any other value on a session request is refused.
 */
export const SESSION_CHANNELS = ['app', 'webmcp'] as const satisfies readonly Channel[];

/** Channels that only read: anything but GET and HEAD is refused before a handler runs. */
export const READ_ONLY_CHANNELS: readonly Channel[] = ['webmcp'];

/**
 * Channels where software calls on a person's session (a page's WebMCP tools serve a browser
 * agent): like an agent, it may not take people-only actions.
 */
export const AGENT_DRIVEN_CHANNELS: readonly Channel[] = ['webmcp'];

/** Is this a channel a session may name in `x-channel`? */
export const isSessionChannel = (value: unknown): value is (typeof SESSION_CHANNELS)[number] =>
  (SESSION_CHANNELS as readonly unknown[]).includes(value);

/** Does this channel only read? */
export const isReadOnlyChannel = (channel: Channel | undefined) =>
  channel !== undefined && READ_ONLY_CHANNELS.includes(channel);

/** Is software, not the person, making this call: an agent, or an agent-driven channel? */
export const drivenByAgent = (p: Pick<Principal, 'actor' | 'channel'>) =>
  p.actor.kind === 'agent' ||
  (p.channel !== undefined && AGENT_DRIVEN_CHANNELS.includes(p.channel));

/** The methods a read-only channel may use: they change nothing. */
export const CHANNEL_READS: readonly string[] = ['GET', 'HEAD'];

/** A channel rule's refusal: the status and the body, as the API answers it everywhere. */
export interface ChannelRefusal {
  status: 400 | 403;
  body: { error: 'bad_channel' | 'forbidden'; rule?: 'read_only_channel'; reason: string };
}

/**
 * Why a signed-in caller may not name this channel in `x-channel` (400 `bad_channel`), or
 * nothing: a session names only its own channels (`SESSION_CHANNELS`).
 */
export function sessionChannelRefusal(named: string | undefined): ChannelRefusal | undefined {
  if (named === undefined || isSessionChannel(named)) return undefined;
  return {
    status: 400,
    body: {
      error: 'bad_channel',
      reason: `A signed-in caller cannot name the channel "${named.slice(0, 40)}"`,
    },
  };
}

/**
 * Why a call on this channel may not do this (403 `read_only_channel`), or nothing. A read-only
 * channel uses only `CHANNEL_READS`; `readsToo` refuses those as well (a route where even a GET
 * signs in or grants, as Better Auth's do).
 */
export function readOnlyChannelRefusal(
  channel: Channel | undefined,
  method: string,
  opts: { readsToo?: boolean } = {},
): ChannelRefusal | undefined {
  if (!isReadOnlyChannel(channel)) return undefined;
  if (!opts.readsToo && CHANNEL_READS.includes(method.toUpperCase())) return undefined;
  return {
    status: 403,
    body: {
      error: 'forbidden',
      rule: 'read_only_channel',
      reason: `Calls on the ${channel} channel can only read`,
    },
  };
}
