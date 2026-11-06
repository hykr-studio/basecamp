import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { api } from '../../api';
import type { AppPlugin } from '../../framework/app-domain';
import { appPathOf } from './links';

export type PushOptions = {
  /** The EAS project id. Default: the app config's `extra.eas.projectId`. */
  projectId?: string;
  /** What Android shows as the notifications' channel name in the app's settings. */
  androidChannel?: string;
};

/** A tapped notification opens its link. */
function open(data: unknown) {
  const path = appPathOf(data);
  if (!path) return;
  try {
    router.navigate(path as never);
  } catch (e) {
    console.warn('A push notification’s link could not open:', e);
  }
}

/**
 * Ask once for permission, then register this device's Expo push token for the signed-in
 * person. Nothing on the web, in a simulator, or when permission is refused.
 */
async function register(options: PushOptions): Promise<string | undefined> {
  if (!Device.isDevice) return undefined;
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('default', {
      name: options.androidChannel ?? 'Notifications',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain)
    permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return undefined;
  const { data: token } = await Notifications.getExpoPushTokenAsync(
    options.projectId ? { projectId: options.projectId } : undefined,
  );
  await api.push.register({ token, platform: Platform.OS === 'ios' ? 'ios' : 'android' });
  return token;
}

/**
 * Push notifications on iOS and Android: after sign-in the device is registered for the
 * person (the server sends what notifications list `push` for), a tap opens the notification's
 * link, and sign-out forgets the device. Needs the `expo-notifications` config plugin in the
 * app's app.json and an EAS project id.
 */
export function pushPlugin(options: PushOptions = {}): AppPlugin {
  return {
    name: 'push',
    onSignedIn: () => {
      if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
      // In the foreground too: a banner and the list, no badge.
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });
      let stopped = false;
      let token: string | undefined;
      const forget = (t: string) => void api.push.forget(t).catch(() => undefined);
      const taps = Notifications.addNotificationResponseReceivedListener((response) =>
        open(response.notification.request.content.data),
      );
      // A tap that started the app.
      void Notifications.getLastNotificationResponseAsync().then((response) => {
        if (!response || stopped) return;
        open(response.notification.request.content.data);
        void Notifications.clearLastNotificationResponseAsync();
      });
      void register(options).then(
        (t) => {
          token = t;
          if (stopped && t) forget(t);
        },
        (e) => console.warn('Push notifications are off: registering this device failed:', e),
      );
      return () => {
        stopped = true;
        taps.remove();
        if (token) forget(token);
      };
    },
  };
}
