/**
 * THE DOMAIN, in the app: meetings, notes and to-dos. Replace this folder and the routes in
 * src/app/(domain) to bring another domain; the shell reads only `appDomain`.
 */
import { defineAppDomain } from '../framework/app-domain';
import { bindDomain } from './bindings';

export const appDomain = defineAppDomain({
  tagline: 'Template app · sample domain: meetings',
  nav: [
    { href: '/', label: 'Today', icon: 'sun', match: (p) => p === '/' },
    {
      href: '/meetings',
      label: 'Meetings',
      icon: 'calendar',
      match: (p) => p.startsWith('/meetings'),
    },
    { href: '/notes', label: 'Notes', icon: 'file-text', match: (p) => p.startsWith('/notes') },
    { href: '/todos', label: 'To-dos', icon: 'check-square', match: (p) => p.startsWith('/todos') },
  ],
  suggestions: [
    { text: 'today', what: "today's meetings and what is due" },
    { text: 'add Book the site visit', what: 'adds a to-do' },
    { text: 'done Book the site visit', what: 'ticks it off' },
    { text: 'delete Book the site visit', what: 'asks you to approve the delete' },
    {
      text: 'close <meeting>',
      what: 'then paste notes on the next lines; waits for your approval',
    },
    { text: 'move <meeting> to 2026-10-31', what: 'moves it and its to-dos' },
  ],
  bind: bindDomain,
});
