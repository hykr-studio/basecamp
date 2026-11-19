// @hykr/connectors: talking to other systems, as transport only. Signed webhooks out and in,
// HMAC checks, sealed credentials, a guarded HTTP client, and the Connector interface the server's
// integrations feature runs, iCalendar text and the telephony provider interface. Google Calendar
// is the subpath @hykr/connectors/google-calendar, Facebook and Instagram lead ads
// @hykr/connectors/meta-leads. Signing a connector in (OAuth) is ./oauth.js. No database, policy,
// Nest or queue code lives here.
export {
  bodyKey,
  type Connector,
  type ConnectorInbound,
  checkEvent,
  defineConnector,
  type ExpandContext,
  type InboundEvent,
  type InboundHeaders,
  type InboundRequest,
  readHeader,
  type SharedApp,
  type SharedInbound,
} from './connector.js';
export {
  checkUrl,
  EgressBlocked,
  type EgressPolicy,
  type EgressResponse,
  EgressTimeout,
  isEgressBlocked,
  isPublicAddress,
  type LookupAll,
  safeRequest,
  type UrlCheck,
} from './egress.js';
export {
  type DigestEncoding,
  type HmacAlgorithm,
  hmacDigest,
  safeEqual,
  type VerifyHmacOptions,
  verifyHmac,
} from './hmac.js';
export {
  type HmacConnectorOptions,
  type HmacCredentials,
  type HmacSignedParts,
  hmacConnector,
} from './hmac-connector.js';
export {
  foldLine,
  type IcsCalendar,
  type IcsEvent,
  type IcsPerson,
  icsCalendar,
  icsDate,
  icsText,
} from './ics.js';
export {
  type ConnectorCall,
  type ConnectorOAuth,
  type ConnectorRequestInit,
  isOAuthError,
  type OAuthAccount,
  type OAuthClient,
  type OAuthContext,
  type OAuthCredentials,
  type OAuthDescription,
  type OAuthEndpoints,
  OAuthError,
  type OAuthHttp,
  type OAuthRequest,
  type OAuthResponse,
  type OAuthTokens,
  oauthAuthorizationUrl,
  oauthCredentials,
  oauthError,
  oauthExchangeCode,
  oauthProblems,
  oauthRefresh,
  oauthRevoke,
  oauthUrlProblem,
  pkceChallenge,
  pkcePair,
  splitScopes,
  tokensOf,
} from './oauth.js';
export {
  createSecretBox,
  SECRET_KEY_MIN_LENGTH,
  type SecretBox,
  SecretBoxError,
} from './secret-box.js';
export {
  DEFAULT_TOLERANCE_SEC,
  generateWebhookSecret,
  signWebhook,
  verifyWebhook,
  WEBHOOK_HEADERS,
  type WebhookVerification,
} from './signature.js';
export { standardWebhooks } from './standard-webhooks.js';
export {
  type DialRequest,
  type DialResult,
  defineTelephonyProvider,
  E164,
  type TelephonyProvider,
} from './telephony.js';
