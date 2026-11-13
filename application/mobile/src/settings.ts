/**
 * The application's own part of the app: its name, and the home screen (Today), which combines
 * the meetings and to-dos modules and so belongs to none of them. The modules are in src/modules.
 */
import type { AppSettings } from '@hykr/app';

export const settings: AppSettings = {
  title: 'Basecamp',
  tagline: 'Sample app: meetings, notes, to-dos, briefs and orders',
  nav: [{ href: '/', label: 'Today', icon: 'sun', match: (p) => p === '/' }],
  home: { href: '/', label: 'Go to Today' },
  suggestions: [{ text: 'today', what: "today's meetings and what is due" }],
  webmcp: { today: { reads: ['meetings', 'todos'] } },
};
