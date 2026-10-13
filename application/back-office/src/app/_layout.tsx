import '../../global.css';
import { BackOfficeShell } from '@hykr/back-office';

/** Read here, in the app's own code, where Expo inlines EXPO_PUBLIC_* variables. */
const config = { apiUrl: process.env.EXPO_PUBLIC_API_URL };

export default function RootLayout() {
  return <BackOfficeShell title="Basecamp" config={config} />;
}
