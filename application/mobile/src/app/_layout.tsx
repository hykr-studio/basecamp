import '../../global.css';
import {
  AppShell,
  agentsPlugin,
  creditsPlugin,
  inboxPlugin,
  livePlugin,
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
 * The framework features the app uses, made once, outside render: the business's flags, branding
 * and phrases, live updates (other people's changes show without a reload), push notifications
 * (the to-do reminder goes to the phone first), WebMCP (each screen's read tools, the modules'
 * `webmcp`, offered to the browser's agent where the browser supports it), the business's
 * credits (usage, the pause, buying more: `/credits`), the in-app inbox (mentions in comments)
 * and the business's agents (`/agents`: the meetings module's ready-made ones among them).
 */
const plugins = [
  settingsPlugin(),
  livePlugin(),
  pushPlugin({ androidChannel: 'Reminders' }),
  webMcpPlugin(),
  creditsPlugin,
  inboxPlugin(),
  agentsPlugin(),
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
