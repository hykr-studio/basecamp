// A telephony provider: the outside service that connects a phone call (click-to-call) for a
// business. Transport only: the server's `calls` feature records the call, picks the provider
// and gives it the business's credentials; the provider only asks its service to dial and says
// what it answered. No provider ships with the framework: an application adds its own.
import type { Labels } from '@hykr/i18n';

/** A phone number in E.164: '+' and 8 to 15 digits. */
export const E164 = /^\+[1-9]\d{7,14}$/;

/** What the server asks a provider to do: connect `from` (a member) with `to`. */
export interface DialRequest {
  /** The call log's id: the provider may send it back with its status updates. */
  callId: string;
  /** The member's own number, when known (some providers ring the member first). */
  from?: string;
  /** Whom to call. */
  to: string;
  /** The number to show the person called, when the business has one with the provider. */
  callerId?: string;
  /** The record the call is about, for the provider's own notes. */
  record?: { entity: string; id: string };
}

/** What the provider's service answered. */
export interface DialResult {
  /** The provider's id for the call: its status updates name it. */
  externalId: string;
  /** Where the call is now. Default 'requested'. */
  status?: 'requested' | 'ringing' | 'in_progress' | 'completed' | 'missed' | 'failed';
}

export interface TelephonyProvider<C = unknown> {
  /** Lower case: 'acme-voice'. Stored on each call it connects. */
  name: string;
  label: Labels;
  /**
   * The B10 connector whose connection holds the business's credentials for this provider.
   * Without one, the provider needs no per-business credentials (a deployment's account).
   */
  connector?: string;
  /** Ask the service to connect the call. Throw when it refuses: the call is marked failed. */
  dial(request: DialRequest, ctx: { credentials?: C }): Promise<DialResult>;
}

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** A provider, checked: its name. */
export function defineTelephonyProvider<C>(def: TelephonyProvider<C>): TelephonyProvider<C> {
  if (!NAME.test(def.name))
    throw new Error(
      `Telephony provider name "${def.name}" must be lower case letters, digits and "-" (at most 40)`,
    );
  return def;
}
