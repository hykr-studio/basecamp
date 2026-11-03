import '../../global.css';
import { AppShell } from '@hykr/app';
import { appDomain, catalog, registry } from '../domain';

/** Read here, in the app's own code, where Expo inlines EXPO_PUBLIC_* variables. */
const config = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
  studioUrl: process.env.EXPO_PUBLIC_STUDIO_URL,
  // app.json's "scheme": the native session is stored under it.
  scheme: 'agenticstack',
};

export default function RootLayout() {
  return <AppShell app={appDomain} catalog={catalog} registry={registry} config={config} />;
}
