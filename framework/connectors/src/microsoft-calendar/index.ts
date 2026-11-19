// @hykr/connectors/microsoft-calendar: a person's Microsoft 365 / Outlook.com calendar, as
// transport only. OAuth (authorization code with PKCE, offline access), the Graph calls a
// connection makes (our events, a delta query for changes, busy times, change subscriptions),
// the inbound connector for Graph's change notifications, and an in-memory fake Microsoft. The
// server's calendar feature decides what goes where and stores the tokens sealed.
export {
  BASECAMP_KEY_PROPERTY,
  DELTA_AHEAD_DAYS,
  DELTA_BACK_DAYS,
  instantOf,
  MICROSOFT_KEY,
  type MicrosoftBusy,
  type MicrosoftCalendarClient,
  type MicrosoftChange,
  type MicrosoftChanges,
  type MicrosoftEventInput,
  type MicrosoftSubscription,
  microsoftCalendarClient,
  SUBSCRIPTION_MINUTES,
  wallTimeIn,
} from './client.js';
export {
  MICROSOFT_CALENDAR_CONNECTOR,
  MICROSOFT_CHANGED_EVENT,
  type MicrosoftNotification,
  type MicrosoftSubscriptionCredentials,
  microsoftCalendarConnector,
  notificationsOf,
  validationTokenOf,
} from './connector.js';
export {
  createFakeMicrosoft,
  type FakeMicrosoft,
  type FakeMicrosoftEvent,
  type FakeSubscription,
  fakeMicrosoft,
} from './fake.js';
export {
  ADMIN_CONSENT_CODES,
  accountOfIdToken,
  isAdminConsentError,
  isMicrosoftRevoked,
  MICROSOFT_CALENDAR_SCOPES,
  type MicrosoftAuthorizationRequest,
  type MicrosoftTokens,
  microsoftAuthorizationUrl,
  microsoftExchangeCode,
  microsoftRefreshToken,
} from './oauth.js';
export {
  aadstsOf,
  guardedTransport,
  hostsOf,
  MICROSOFT_ENDPOINTS,
  MicrosoftApiError,
  type MicrosoftEndpoints,
  type MicrosoftRequest,
  type MicrosoftResponse,
  type MicrosoftTransport,
  microsoftError,
} from './transport.js';
