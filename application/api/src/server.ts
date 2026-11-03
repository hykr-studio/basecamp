// The application, as the server runs it: the domain's entities and commands, the Nest module
// that serves them, its views, its notifications and its assistant. `basecamp dev` and
// `basecamp start` run the API and the worker from this file.

import { agentDomain } from '@application/domain/agent';
import { domain } from '@application/domain/contracts';
import { migrations } from '@application/domain/db';
import { domainNotifications, domainTemplates } from '@application/domain/notifications';
import { DomainModule } from '@application/domain/server';
import { uiDomain } from '@application/domain/views';
import { defineServer } from '@hykr/api';

export const server = defineServer({
  domain,
  module: DomainModule,
  views: uiDomain,
  notifications: { templates: domainTemplates, notifications: domainNotifications },
  agent: agentDomain,
  // On WhatsApp, in the welcome and in HELP.
  channel: {
    does: {
      en: 'I can add, list and complete your to-dos and meetings.',
      hi: 'मैं आपके काम और मीटिंग जोड़ सकता हूँ, दिखा सकता हूँ और पूरे कर सकता हूँ।',
      te: 'నేను మీ పనులు, మీటింగ్‌లను జోడించగలను, చూపించగలను, పూర్తి చేయగలను.',
    },
  },
  migrations: [migrations],
});
