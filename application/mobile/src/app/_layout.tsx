import '../../global.css';
import { AppShell } from '@hykr/app';
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

export default function RootLayout() {
  return (
    <AppShell
      app={settings}
      modules={modules}
      catalog={catalog}
      registry={registry}
      config={config}
    />
  );
}
