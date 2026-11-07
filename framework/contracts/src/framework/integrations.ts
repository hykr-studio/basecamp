// The integrations feature's trait: whether an entity's events may leave the platform as
// outbound webhooks. Read by the server's integrations feature.
import type { EntitySpec } from './spec.js';

declare module './traits.js' {
  interface EntityTraits {
    /**
     * `false`: this entity's events are never sent to a webhook endpoint. Default: they may be,
     * projected for the endpoint (its read schema, field policy and read projectors).
     */
    webhooks?: boolean;
  }
}

/** May this entity's events go to webhook endpoints? */
export const sendsWebhooks = (spec: Pick<EntitySpec, 'traits'>): boolean =>
  spec.traits?.webhooks !== false;
