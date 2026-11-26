import { ScrollView, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { ScreenTitle } from '../../components/ScreenTitle';
import { useScreenContext } from '../../framework/assistant-context';
import { EmptyState } from '../../framework/EmptyState';
import { useT } from '../../framework/lang';
import { space, styles } from '../../theme';
import { useOutbox } from './hooks';
import { OfflineBanner, PendingWriteRow } from './PendingWrites';

/**
 * `/offline`: every change kept on this device, oldest first, each with where it stands; a
 * refused one with the server's reason, Try again (or, after a conflict, Save mine anyway) and
 * Discard.
 */
export function OfflineScreen() {
  useScreenContext({ screen: 'offline' });
  const { t } = useT();
  const { items, online, syncing, waiting, sync } = useOutbox();
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ScreenTitle title={t('offline.title')} />
      <Text style={styles.muted}>{t('offline.hint')}</Text>
      <OfflineBanner />
      {items.length ? (
        <View style={[styles.card, { gap: space.lg }]}>
          {items.map((item) => (
            <PendingWriteRow key={item.id} item={item} />
          ))}
        </View>
      ) : (
        <EmptyState icon="check-circle" title={t('offline.empty')} />
      )}
      {waiting > 0 && (
        <View style={styles.row}>
          <Button
            title={t('offline.syncNow')}
            icon="refresh-cw"
            busy={syncing}
            disabled={!online}
            onPress={() => void sync()}
          />
        </View>
      )}
    </ScrollView>
  );
}
