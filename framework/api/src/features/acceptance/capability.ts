import { defineCapability } from '@hykr/contracts';

/**
 * See an acceptance's full evidence: the number or email the code went to, the IP, user agent
 * and device, and an e-sign provider's certificate. Owner and admin by default. Anyone else who
 * reaches the record sees that it was accepted, by whom and when, with the address masked.
 */
export const AcceptanceEvidenceCapability = defineCapability({
  name: 'acceptances.evidence',
  label: {
    en: 'See acceptance evidence',
    hi: 'स्वीकृति के प्रमाण देखें',
    te: 'అంగీకార సాక్ష్యాన్ని చూడండి',
  },
  roles: ['owner', 'admin'],
  supportable: true,
});
