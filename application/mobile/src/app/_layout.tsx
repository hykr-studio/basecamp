import '../../global.css';
import {
  AppShell,
  businessesPlugin,
  calendarPlugin,
  connectionsPlugin,
  creditsPlugin,
  exportPlugin,
  inboxPlugin,
  livePlugin,
  privacyPlugin,
  pushPlugin,
  settingsPlugin,
  webMcpPlugin,
} from '@hykr/app';
import { catalog, registry } from '@/catalog';
import * as modules from '@/modules';
import { settings } from '@/settings';

/** Read here, in the app's own code, where Expo inlines EXPO_PUBLIC_* variables. */
const config = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
  studioUrl: process.env.EXPO_PUBLIC_STUDIO_URL,
  // app.json's "scheme": the native session is stored under it.
  scheme: 'agenticstack',
};

/**
 * The framework features the app uses, made once, outside render: the business switcher
 * (`/businesses`: a person in several businesses, as a member or a participant, chooses the one
 * they work in, or joins one with an invitation code), the business's flags, branding and
 * phrases, live updates (other people's changes show without a reload), push notifications (the
 * to-do reminder goes to the phone first), WebMCP (each screen's read tools, the modules'
 * `webmcp`, offered to the browser's agent where the browser supports it), the business's
 * credits (usage, the pause, buying more: `/credits`), the person's calendars (connect Google,
 * feed links: `/calendar`), the in-app inbox (mentions in comments), exporting the business's
 * data (`/export`, for people who may: owners, unless the business grants it to another role),
 * the AI apps a person connected over MCP (`/connections`) and "Your data" (`/privacy`: a copy
 * of what the business keeps about you, or erasure). The switcher goes first: switching starts
 * everything after it again in the other business.
 */
const plugins = [
  businessesPlugin,
  settingsPlugin(),
  livePlugin(),
  pushPlugin({ androidChannel: 'Reminders' }),
  webMcpPlugin(),
  creditsPlugin,
  calendarPlugin(),
  inboxPlugin(),
  exportPlugin,
  connectionsPlugin,
  privacyPlugin,
];

export default function RootLayout() {
  return (
    <AppShell
      app={settings}
      modules={modules}
      plugins={plugins}
      catalog={catalog}
      registry={registry}
      config={config}
    />
  );
}
