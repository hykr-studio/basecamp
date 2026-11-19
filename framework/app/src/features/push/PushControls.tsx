// Web push's controls: a strip that offers notifications in this browser, and the switch in the
// person's card. Both ask for the browser's permission only when the person clicks.
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Icon } from '../../framework/Icon';
import { useT } from '../../framework/lang';
import { colors, space, styles } from '../../theme';
import { disableWebPush, enableWebPush, usePushStatus } from './web';

const DISMISSED_KEY = 'hykr.push.offerDismissed';
const dismissedBefore = () => {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
};
const dismiss = () => {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // No storage: hidden for this page only.
  }
};

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Turning notifications on, with what went wrong if it did. */
function useEnable() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    action()
      .catch((e) => setError(reasonOf(e)))
      .finally(() => setBusy(false));
  };
  return { busy, error, run };
}

/**
 * Above the screen while notifications are off in this browser and the person has not said
 * "not now": one click turns them on. Draws nothing anywhere else (phones, unsupported).
 */
export function PushBanner() {
  const { t } = useT();
  const status = usePushStatus();
  const [hidden, setHidden] = useState(dismissedBefore);
  const { busy, error, run } = useEnable();
  if (status !== 'off' || hidden) return null;
  return (
    <View style={s.banner} accessibilityRole="summary">
      <Icon name="bell" size={16} color={colors.text} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.label}>{t('push.offer')}</Text>
        {error && (
          <Text style={[styles.muted, { color: colors.danger }]}>
            {t('push.failed', { reason: error })}
          </Text>
        )}
      </View>
      <Button title={t('push.turnOn')} busy={busy} onPress={() => run(enableWebPush)} />
      <Button
        title={t('push.notNow')}
        variant="subtle"
        onPress={() => {
          dismiss();
          setHidden(true);
        }}
      />
    </View>
  );
}

/**
 * Notifications in this browser, for the person's card: on (with a way to turn them off), off
 * (a button that turns them on), or blocked (where to allow them). Nothing on a phone or a
 * browser without web push.
 */
export function PushToggle() {
  const { t } = useT();
  const status = usePushStatus();
  const { busy, error, run } = useEnable();
  if (!status || status === 'unsupported') return null;
  return (
    <View style={{ gap: space.xs }}>
      {status === 'on' ? (
        <View style={s.row}>
          <Icon name="bell" size={16} color={colors.text} />
          <Text style={[styles.muted, { flex: 1 }]}>{t('push.on')}</Text>
          <Button
            title={t('push.turnOff')}
            variant="subtle"
            busy={busy}
            onPress={() => run(disableWebPush)}
          />
        </View>
      ) : status === 'blocked' ? (
        <View style={s.row}>
          <Icon name="bell-off" size={16} color={colors.muted} />
          <Text style={[styles.muted, { flex: 1 }]}>{t('push.blocked')}</Text>
        </View>
      ) : (
        <Button
          title={t('push.turnOn')}
          variant="secondary"
          icon="bell"
          busy={busy}
          onPress={() => run(enableWebPush)}
        />
      )}
      {error && (
        <Text style={[styles.muted, { color: colors.danger }]}>
          {t('push.failed', { reason: error })}
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderWidth: 1,
    borderRadius: 8,
    marginBottom: space.sm,
    backgroundColor: colors.card,
    borderColor: colors.border,
  },
});
