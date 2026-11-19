import { text } from 'drizzle-orm/pg-core';

/**
 * On a shared entity's table (A11): the platform row this business's row overrides, or null.
 * Its JS key must be `sharedId`. Add a unique index on (tenant_id, shared_id).
 */
export const sharedFromColumn = () => text('shared_id');
