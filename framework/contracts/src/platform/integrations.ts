// A business's integrations (B10, B24) as the API lists them: the kinds of outside systems it can
// connect, and its connections. Never a credential or a token.
import type { Labels } from '@hykr/i18n';

/** One kind of outside system (`GET /api/integrations/connectors`). */
export interface ConnectorInfo {
  name: string;
  label: Labels;
  description?: Labels;
  /** It takes requests in (webhooks). */
  inbound: boolean;
  /** It makes its own credentials for a new connection. */
  generates: boolean;
  publicFields: string[];
  /** Connected by signing in: what it asks for, whether this server offers it, a pick step. */
  oauth: { scopes: string[]; available: boolean; pick: boolean } | null;
  /** The provider posts to one URL for everyone (`/webhooks/<name>`). */
  sharedInbound: string | null;
}

/** An account a signed-in connection reaches (a page): its id and name. */
export interface ConnectionAccount {
  id: string;
  name: string;
  /** Picked: it receives events. */
  held: boolean;
}

/** One connection of the business (`GET /api/integrations/connections`). */
export interface ConnectionInfo {
  id: string;
  connector: string;
  label: string | null;
  /** `needs_reauth`: the provider no longer takes its grant; sign it in again. */
  status: 'active' | 'disabled' | 'needs_reauth';
  auth: 'credentials' | 'oauth';
  public: Record<string, unknown>;
  scopes: string[];
  tokenExpiresAt: string | null;
  lastError: string | null;
  inboundPath: string;
  /** A signed-in connection's accounts. */
  accounts?: ConnectionAccount[];
  createdAt: string;
  updatedAt: string;
}
