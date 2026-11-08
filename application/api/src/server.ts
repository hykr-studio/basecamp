// The application, as the server runs it: its modules (each with its entities, commands, Nest
// module, views, notifications and assistant part), who the assistant is, and the migrations.
// `basecamp dev` and `basecamp start` run the API and the worker from this file.

import { migrations } from '@application/domain/db';
import { languages } from '@application/domain/languages';
import { modules } from '@application/domain/modules';
import { contributions } from '@application/domain/server';
import { defineServer } from '@hykr/api';

export const server = defineServer({
  name: 'Meetings',
  persona:
    'You are a meetings assistant. You help the user plan meetings, keep notes, and track action items.',
  help: 'I can add, list, complete or delete to-dos, show today, and close or move meetings.',
  // English, Hindi and Telugu (the app speaks the same ones).
  languages,
  // On WhatsApp, in the welcome and in HELP.
  channel: {
    does: {
      en: 'I can add, list and complete your to-dos and meetings.',
      hi: 'मैं आपके काम और मीटिंग जोड़ सकता हूँ, दिखा सकता हूँ और पूरे कर सकता हूँ।',
      te: 'నేను మీ పనులు, మీటింగ్‌లను జోడించగలను, చూపించగలను, పూర్తి చేయగలను.',
    },
  },
  modules,
  migrations: [migrations],
  // Its approval levels (read, internal, external, irreversible) and the rules that are not one
  // module's.
  contributes: contributions,
});
