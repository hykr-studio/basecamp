import { z } from 'zod';
import { defineScreen } from '../define-view.js';

export const PageScreen = defineScreen({
  name: 'page.view',
  title: 'saved page',
  description: "A page the person saved (from list-pages), opened with today's data.",
  params: z.object({ id: z.uuid() }),
});
