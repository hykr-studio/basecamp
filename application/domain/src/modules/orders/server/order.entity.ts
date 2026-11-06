import { defineEntity } from '@hykr/core';
import { OrderSpec } from '../contracts/index.js';
import { orders } from '../db/schema.js';

/**
 * Orders: plain CRUD. Without `access`, people reach their own rows and a customer theirs;
 * give it an `Access` (@hykr/policy) to open more to a role.
 */
export const Order = defineEntity(OrderSpec, {
  table: orders,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
});
