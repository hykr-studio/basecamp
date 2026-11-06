import '../../global.css';
import { AppShell, livePlugin, pushPlugin, webMcpPlugin } from '@hykr/app';
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
 * The framework features the app uses: live updates (other people's changes show without a
 * reload), push notifications (the to-do reminder goes to the phone first) and WebMCP (each
 * screen's read tools, the modules' `webmcp`, offered to the browser's agent where the browser
 * supports it).
 */
const plugins = [livePlugin(), pushPlugin({ androidChannel: 'Reminders' }), webMcpPlugin()];

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
