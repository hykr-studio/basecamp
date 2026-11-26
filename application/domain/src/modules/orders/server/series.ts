import { defineNumberSeries } from '@hykr/contracts';

/**
 * Order numbers: ORD/2026-27/0001, counted per business and started again each financial year
 * (the business's `money.fyStartMonth`, in its time zone).
 */
export const OrderSeries = defineNumberSeries({
  name: 'orders.order',
  format: 'ORD/{fy}/{seq:4}',
  reset: 'fiscal',
});
