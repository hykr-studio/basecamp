// @hykr/connectors/google-calendar: a person's Google Calendar, as transport only. OAuth (PKCE,
// offline access), the Calendar API calls a connection makes (our events, changes, busy times,
// push channels), the inbound connector for Google's push notifications, and an in-memory fake
// Google. The server's calendar feature decides what goes where and stores the tokens sealed.
export {
  type BusyInterval,
  EVENT_ID,
  type GoogleCalendarClient,
  type GoogleChanges,
  type GoogleChannel,
  type GoogleEvent,
  type GoogleTime,
  googleCalendarClient,
  mergeBusy,
} from './client.js';
export {
  CHANGED_EVENT,
  GOOGLE_CALENDAR_CONNECTOR,
  type GoogleChannelCredentials,
  type GoogleNotification,
  googleCalendarConnector,
  HANDSHAKE_EVENT,
  notificationHeaders,
  notificationOf,
} from './connector.js';
export { createFakeGoogle, type FakeChannel, type FakeGoogle, fakeGoogle } from './fake.js';
export {
  type AuthorizationRequest,
  authorizationUrl,
  emailOfIdToken,
  exchangeCode,
  GOOGLE_CALENDAR_SCOPES,
  type GoogleTokens,
  pkceChallenge,
  pkcePair,
  refreshAccessToken,
  revokeToken,
} from './oauth.js';
export {
  fetchTransport,
  GOOGLE_ENDPOINTS,
  GoogleApiError,
  type GoogleEndpoints,
  type GoogleRequest,
  type GoogleResponse,
  type GoogleTransport,
  googleError,
} from './transport.js';
