// Outside AI clients a person connects over MCP (A1), as the API lists them.

/** One client a person allowed in one business: what it is called and what it may do. */
export interface McpConnection {
  clientId: string;
  /** The name the client registered with, as it says (unverified). */
  name: string;
  uri: string | null;
  /** `<module>:read`, `<module>:write`, `offline_access`. */
  scopes: string[];
  connectedAt: string | null;
  updatedAt: string | null;
}
