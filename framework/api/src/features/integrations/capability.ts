import { defineCapability } from '@hykr/contracts';

/**
 * Set up the business's integrations: webhook endpoints, connections and their credentials, and
 * read the delivery log. Owner and admin by default, like the WhatsApp number.
 */
export const IntegrationsCapability = defineCapability({
  name: 'integrations.manage',
  label: {
    en: "Manage the business's integrations",
    hi: 'व्यवसाय के इंटीग्रेशन प्रबंधित करें',
    te: 'వ్యాపార ఇంటిగ్రేషన్‌లను నిర్వహించండి',
  },
  roles: ['owner', 'admin'],
  supportable: false,
});
