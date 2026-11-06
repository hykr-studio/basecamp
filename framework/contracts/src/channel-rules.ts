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
