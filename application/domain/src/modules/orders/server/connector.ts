import { defineConnectorHandler } from '@hykr/api';
import { defineConnector, readHeader, verifyHmac } from '@hykr/connectors';
import { transitionOp } from '@hykr/core';
import { participations } from '@hykr/db';
import type { Labels } from '@hykr/i18n';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { SupplierRole } from '../contracts/index.js';
import { Order } from './order.entity.js';

/** Where the supplier's system signs, and names its event. */
const SIGNATURE = 'x-supplier-signature';
const EVENT_ID = 'x-supplier-event';

const SupplierCredentials = z.object({
  /** What the supplier's system signs each request's body with (HMAC-SHA256). */
  secret: z.string().min(32).max(200),
  /** The supplier: a party of the business. The connection takes its reports, on its orders. */
  partyId: z.uuid(),
});
export type SupplierCredentials = z.infer<typeof SupplierCredentials>;

const Body = z.object({ type: z.string().min(1).max(200), data: z.unknown() });

const L = {
  label: { en: 'Supplier updates', hi: 'आपूर्तिकर्ता अपडेट', te: 'సరఫరాదారు అప్‌డేట్‌లు' },
  description: {
    en: "A supplier's system reports on the orders placed with it: a fulfilled order is marked fulfilled.",
    hi: 'आपूर्तिकर्ता का सिस्टम उसके पास दिए गए ऑर्डर की जानकारी देता है: पूरा हुआ ऑर्डर पूरा दर्ज होता है।',
    te: 'సరఫరాదారు సిస్టమ్ దానికి ఇచ్చిన ఆర్డర్ల గురించి తెలుపుతుంది: పూర్తయిన ఆర్డర్ పూర్తయినట్లుగా నమోదవుతుంది.',
  },
} satisfies Record<string, Labels>;

/**
 * The orders module's connector (B10): a supplier's own system, one connection per supplier.
 * It signs the raw body with HMAC-SHA256 (`x-supplier-signature: sha256=<hex>`, checked in
 * constant time) and names each event (`x-supplier-event`, so a redelivery is stored once). The
 * body is `{ type, data }`. The business gives the shared secret and the supplier's party when it
 * adds the connection (`POST /api/integrations/connections`); the party is shown back, never
 * the secret. Posts go to /webhooks/orders-supplier/<connection id>.
 */
export const SupplierConnector = defineConnector<SupplierCredentials>({
  name: 'orders-supplier',
  label: L.label,
  description: L.description,
  credentials: SupplierCredentials,
  publicFields: ['partyId'],
  inbound: {
    verify: (req, creds) =>
      verifyHmac({
        secret: creds.secret,
        payload: req.rawBody,
        signature: readHeader(req.headers, SIGNATURE),
        prefix: 'sha256=',
      }),
    parse: (req) => {
      const id = readHeader(req.headers, EVENT_ID);
      if (!id) throw new Error(`Name the event in ${EVENT_ID}`);
      const body = Body.parse(req.body);
      return [{ id, type: body.type, data: body.data ?? null }];
    },
  },
});

const Fulfilled = z.object({ orderId: z.uuid() });

const refuse = (rule: string, reason: string) =>
  new ForbiddenException({ error: 'forbidden', rule, reason });

/**
 * `order.fulfilled { orderId }` from a supplier's system: the order is fulfilled, as the
 * business's system principal (audited as `integrations.orders-supplier`, the stored event as
 * its run), through the order's own `fulfil` transition. Only an accepted order (one placed with
 * the supplier) that this connection's party supplies; anything else fails for good and changes
 * nothing. Another business's order is never one: its participations are its own.
 */
export const SupplierFulfilled = defineConnectorHandler({
  name: 'orders.supplier-fulfilled',
  connector: SupplierConnector.name,
  on: ['order.fulfilled'],
  handle: async (event, ctx) => {
    const data = Fulfilled.safeParse(event.data);
    if (!data.success)
      throw new BadRequestException({
        error: 'invalid',
        rule: 'supplier_event_invalid',
        reason: 'An order.fulfilled event names its order: { "orderId": "<uuid>" }',
      });
    const { orderId } = data.data;
    // The party from the sealed credentials the request was verified with, not the clear copy.
    const { partyId } = await ctx.credentials<SupplierCredentials>();
    const [supplies] = await ctx.db
      .select({ id: participations.id })
      .from(participations)
      .where(
        and(
          eq(participations.tenantId, event.tenantId),
          eq(participations.resourceType, Order.name),
          eq(participations.resourceId, orderId),
          eq(participations.partyId, partyId),
          eq(participations.role, SupplierRole.name),
        ),
      )
      .limit(1);
    if (!supplies)
      throw refuse('not_supplier', "This connection's supplier does not supply this order");
    const order = await Order.repo.get(ctx.db, ctx.principal, orderId);
    if (order.status !== 'accepted')
      throw refuse(
        'order_not_accepted',
        `This order is ${order.status}: a supplier reports only on an accepted order`,
      );
    await ctx.write(transitionOp(Order, { id: orderId, transition: 'fulfil' }), {});
  },
});
