/** The orders module's specs: isomorphic, read by the server and the apps. */
import { moduleSpec } from '@hykr/contracts';
import { OrderSpec } from './order.js';

export * from './order.js';

export const ordersSpec = moduleSpec({
  name: 'orders',
  // The modules it builds on: it may import only their contracts/ and server/public.ts.
  dependsOn: [],
  entities: { orders: OrderSpec },
  commands: [],
});
