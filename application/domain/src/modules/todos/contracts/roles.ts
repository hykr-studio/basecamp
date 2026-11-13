// The to-dos module's own role and capability: a buyer works on the to-dos granted to them and
// sees what each costs, which nobody else below an admin does. The framework knows neither.
import { defineCapability, defineRole } from '@hykr/contracts';

/** Who sees a to-do's cost (and may set it). */
export const SeeTodoCost = defineCapability({
  name: 'todos.cost.read',
  label: { en: 'See what to-dos cost', hi: 'कामों की लागत देखें', te: 'పనుల ఖర్చు చూడండి' },
  roles: ['owner', 'admin'],
});

/** Buys what the to-dos need: reaches only the to-dos granted to them, and their cost. */
export const Buyer = defineRole({
  name: 'buyer',
  label: { en: 'Buyer', hi: 'खरीदार', te: 'కొనుగోలుదారు' },
  capabilities: [SeeTodoCost.name, 'members.read'],
});
