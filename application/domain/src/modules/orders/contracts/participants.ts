import { defineParticipantRole } from '@hykr/contracts';

/**
 * The organisation that supplies an order: reached on WhatsApp (its people's numbers) or with an
 * account. It reads the orders it supplies and their lines, never what the lines cost the
 * business. Its own details (registration, bank, agreed rates) are the business's records about
 * it, kept beside the party, not in the framework.
 */
export const SupplierRole = defineParticipantRole({
  name: 'supplier',
  label: { en: 'Supplier', hi: 'आपूर्तिकर्ता', te: 'సరఫరాదారు' },
  kinds: ['organisation'],
  on: ['order'],
});
