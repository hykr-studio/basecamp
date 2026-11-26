// The application, as the server runs it: its modules (each with its entities, commands, Nest
// module, views, notifications and assistant part), who the assistant is, and the migrations.
// `basecamp dev` and `basecamp start` run the API and the worker from this file.

import { migrations } from '@application/domain/db';
import { languages } from '@application/domain/languages';
import { modules } from '@application/domain/modules';
import { contributions } from '@application/domain/server';
import { defineServer } from '@hykr/api';

export const server = defineServer({
  // Its name where outsiders meet it: an MCP client's consent screen and the MCP server's name.
  name: 'Basecamp',
  persona:
    'You are the assistant of a business and its customers. You help plan and close meetings, keep notes, track to-dos, take briefs and prepare orders.',
  help: 'I can add, list, complete or delete to-dos, show today, close or move meetings, keep notes, and save, submit or revise orders.',
  // English, Hindi and Telugu (the app speaks the same ones).
  languages,
  // On WhatsApp, in the welcome and in HELP.
  channel: {
    does: {
      en: 'I can add, list and update your to-dos, meetings, notes and orders.',
      hi: 'मैं आपके काम, मीटिंग, नोट्स और ऑर्डर जोड़ सकता हूँ, दिखा सकता हूँ और बदल सकता हूँ।',
      te: 'నేను మీ పనులు, మీటింగ్‌లు, నోట్స్, ఆర్డర్‌లను జోడించగలను, చూపించగలను, మార్చగలను.',
    },
  },
  modules,
  migrations: [migrations],
  // Its approval levels (read, internal, external, irreversible) and the rules that are not one
  // module's.
  contributes: contributions,
});
