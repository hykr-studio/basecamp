import { definePublicForm } from '@hykr/contracts';
import { BRIEF_FORM } from '../contracts/index.js';

/**
 * The brief form (decisions B9): what a customer answers on the business's link, sent to one
 * customer (their WhatsApp contact or customer record) or posted for anyone. Each answer is one
 * brief, owned by the business and belonging to that customer (or a new customer named by their
 * answer). The questions are the brief's own fields, then the business's custom fields of briefs.
 */
export const BriefForm = definePublicForm({
  name: BRIEF_FORM,
  entity: 'brief',
  label: {
    en: 'Tell us what you need',
    hi: 'हमें बताइए आपको क्या चाहिए',
    te: 'మీకు ఏమి కావాలో మాకు చెప్పండి',
  },
  description: {
    en: 'A few questions, so we can come back to you with the right answer.',
    hi: 'कुछ सवाल, ताकि हम आपको सही जवाब दे सकें।',
    te: 'కొన్ని ప్రశ్నలు, మీకు సరైన సమాధానం ఇవ్వడానికి.',
  },
  fields: ['name', 'phone', 'summary', 'budget', 'neededBy', 'notes'],
  customerName: 'name',
  fixed: { source: 'form' },
});
