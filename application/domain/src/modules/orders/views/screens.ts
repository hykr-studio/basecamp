import { defineScreen } from '@hykr/ui-registry';
import { z } from 'zod';

export const OrderDetailScreen = defineScreen({
  name: 'order.detail',
  title: 'order',
  description: 'One order in full: its groups and lines, tax lines and totals, and its history.',
  params: z.object({ id: z.uuid() }),
});
