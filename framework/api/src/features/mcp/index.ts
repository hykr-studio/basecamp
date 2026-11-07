import { defineFeature } from '../feature.js';
import { mcpEnabled } from './config.js';
import { McpConnectionsController } from './connections.controller.js';
import { mcpIdentityProvider } from './identity.js';
import { McpController, McpMetadataController } from './mcp.controller.js';
import { mcpAuthPlugin, mcpNativeClients } from './oauth.js';
import { McpPagesController } from './pages.controller.js';
import { McpServers } from './server.js';

/**
 * Outside AI clients over the Model Context Protocol (A1): an OAuth 2.1 authorization server
 * (Better Auth's oauth-provider, with the sign-in and consent pages), the MCP endpoint `/mcp`
 * with two tools per module, the bearer identity provider that makes a token an agent acting
 * for its person, and the person's connections. `MCP=off` leaves all of it out.
 */
export const mcpFeature = defineFeature({
  name: 'mcp',
  enabled: mcpEnabled,
  controllers: [McpController, McpMetadataController, McpPagesController, McpConnectionsController],
  providers: [McpServers],
  contributes: {
    authPlugins: [mcpAuthPlugin, mcpNativeClients],
    identityProviders: [mcpIdentityProvider],
  },
});

export { ACCESS_PREFIX, MCP_PATH, mcpConfig, REFRESH_PREFIX } from './config.js';
export { mcpAgentId } from './identity.js';
export { mcpScopes } from './oauth.js';
export { fieldsOf, mcpTools, parkedText } from './tools.js';
