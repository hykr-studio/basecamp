import { defineParticipantRole } from '@hykr/contracts';

/**
 * Someone of the customer's household at a meeting: a person the business adds to it (by their
 * WhatsApp number, or an emailed link to an account). They read the meeting; they are never a
 * member of the business.
 */
export const HouseholdRole = defineParticipantRole({
  name: 'household',
  label: { en: 'Household', hi: 'परिवार', te: 'కుటుంబం' },
  kinds: ['person'],
  on: ['meeting'],
});
