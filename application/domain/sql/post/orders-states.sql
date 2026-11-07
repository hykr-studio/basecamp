-- The orders module's states (B6, docs/decisions/B6B4.md). Before its state machine, an order
-- was 'open' or 'cancelled': an open one is a draft now. Then a CHECK keeps the column to the
-- states the module declares (ORDER_STATES in contracts/order.ts); change both together.
UPDATE app.orders SET status = 'draft' WHERE status = 'open';

ALTER TABLE app.orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE app.orders ADD CONSTRAINT orders_status_check CHECK (
  status IN ('draft', 'submitted', 'approved', 'fulfilled', 'cancelled', 'superseded', 'expired')
);
