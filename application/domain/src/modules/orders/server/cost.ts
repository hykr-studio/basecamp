import { defineCapability, type Principal } from '@hykr/contracts';
import type { ReadProjector } from '@hykr/core';
import { can } from '@hykr/policy';

/** Who sees what an order's lines cost the business. */
export const OrdersCostRead = defineCapability({
  name: 'orders.cost.read',
  label: {
    en: "See what an order's lines cost",
    hi: 'ऑर्डर की लाइनों की लागत देखें',
    te: 'ఆర్డర్ లైన్ల ఖర్చు చూడండి',
  },
  roles: ['owner', 'admin'],
  // Seeing a cost is a read: the platform's support access may hold it when a business consents.
  // `orders.approve` says nothing, so support never approves an order.
  supportable: true,
});

const withoutCost = (item: unknown) => {
  if (!item || typeof item !== 'object') return item;
  const { cost: _cost, ...rest } = item as Record<string, unknown>;
  return rest;
};

/**
 * A line's cost is hidden from anyone without orders.cost.read, wherever an item leaves the
 * server: item reads, a save's result (its items are read as order items) and a save waiting
 * for approval (its input).
 */
export const costHidden: ReadProjector = {
  name: 'orders.cost-hidden',
  project: (type, value, p: Principal) => {
    if (can(p, OrdersCostRead.name)) return value;
    if (type === 'orderItem') return withoutCost(value) as Record<string, unknown>;
    const input = value.input as { items?: unknown[] } | undefined;
    if (type === 'approval' && value.action === 'order.save' && Array.isArray(input?.items))
      return { ...value, input: { ...input, items: input.items.map(withoutCost) } };
    return value;
  },
};
