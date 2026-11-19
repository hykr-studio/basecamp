// What a calendar service is to the calendar feature (decisions B21): its sign-in, the busy
// times it reads, the events it keeps for records, the changes it reports, and the channel it
// tells us about them through. Google and Microsoft implement it; tokens, sign-in states,
// needs_reauth, feeds and invites stay the feature's own, shared by every provider.
import type { CalendarProvider } from '@hykr/contracts';

export type ProviderName = CalendarProvider;

/** A grant's tokens, as a provider returns them. `expiresAt` is epoch milliseconds. */
export interface ProviderTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  /** The account, when the provider named it with the grant. */
  email?: string;
  accountId?: string;
}

/** An event we keep in a person's calendar for one record. */
export interface CalendarEventInput {
  /** Deterministic for the record (the same for every person): a retry finds it again. */
  key: string;
  /** The provider's id for it, when it was written before. */
  providerId?: string;
  title: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  /** The zone the event is written in (IANA). */
  timeZone: string;
  /** Whose record it is. */
  mark: { tenant: string; entity: string; record: string };
}

/** One change the provider reported to one of the events it may hold for us. */
export type ProviderChange =
  | { providerId: string; removed: true }
  | { providerId: string; removed: false; startsAt: string; endsAt: string };

export interface ProviderChanges {
  items: ProviderChange[];
  /** Where to look from next time. */
  cursor: string;
  /** The old cursor no longer worked: `items` is everything, not changes. */
  reset: boolean;
}

/** A push channel (Google) or subscription (Microsoft) the provider opened. */
export interface ProviderWatch {
  channelId: string;
  resourceId: string | null;
  expiresAt: Date;
}

/** Why a sign-in was refused, in words to show: `admin_consent_required`. */
export interface ProviderRefusal {
  rule: string;
  message: string;
}

export interface CalendarProviderDef {
  name: ProviderName;
  /** The service, as people know it: 'Google', 'Microsoft'. */
  label: string;
  mode: 'live' | 'fake';
  /** The B10 connector its notifications arrive through. */
  inboundConnector: string;
  /** The system principal's job name for what it reports. */
  jobName: string;
  /** The secret the provider sends back with each notification, from the inbound credentials. */
  watchSecret(credentials: unknown): string | null;
  oauth: {
    authorizationUrl(a: { state: string; codeChallenge: string; loginHint?: string }): string;
    exchangeCode(a: { code: string; codeVerifier: string }): Promise<ProviderTokens>;
    refresh(refreshToken: string): Promise<ProviderTokens>;
    /** Withdraw the grant, where the provider can. */
    revoke?(token: string): Promise<void>;
    /** Offline: the fake consent screen agrees at once, as this address. */
    fakeConsent?(url: string, email: string): string;
  };
  /** The provider refused the grant for good: the person must connect again. */
  isRevoked(e: unknown): boolean;
  /** A refusal with its own words (an error from the exchange, or the callback's query). */
  refusal(e: unknown): ProviderRefusal | null;
  /** The account a grant is for. */
  account(tokens: ProviderTokens): { email: string; id?: string };
  freeBusy(
    accessToken: string,
    a: { from: string; to: string; calendarId: string; account: string },
  ): Promise<{ start: string; end: string }[]>;
  upsertEvent(
    accessToken: string,
    calendarId: string,
    event: CalendarEventInput,
  ): Promise<{ providerId: string }>;
  deleteEvent(accessToken: string, calendarId: string, providerId: string): Promise<void>;
  changes(
    accessToken: string,
    a: { calendarId: string; cursor: string | null; tenantId: string },
  ): Promise<ProviderChanges>;
  watch?(
    accessToken: string,
    a: { calendarId: string; address: string; secret: string; ttlSeconds: number },
  ): Promise<ProviderWatch>;
  stopWatch?(
    accessToken: string,
    a: { channelId: string; resourceId: string | null },
  ): Promise<void>;
}
