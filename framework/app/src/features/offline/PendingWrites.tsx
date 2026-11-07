import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { when } from '../../framework/dates';
import { Icon, type IconName } from '../../framework/Icon';
import { useT } from '../../framework/lang';
import type { PendingWrite } from '../../framework/write-queue';
import { getCatalog } from '../../runtime';
import { colors, space, styles } from '../../theme';
import { useOutbox } from './hooks';

type T = ReturnType<typeof useT>['t'];

/** What a queued write is, in the person's words: "New to-do: “Call the plumber”". */
export function pendingLabel(item: PendingWrite, t: T): string {
  const catalog = getCatalog();
  const said =
    item.op.kind === 'command'
      ? t('offline.command', {
          what: catalog.commandByName(item.op.command)?.verb?.do ?? item.op.command,
        })
      : t(`offline.${item.op.action}`, {
          what: catalog.entities[item.op.entity]?.label ?? item.op.entity,
        });
  return item.title ? `${said}: “${item.title}”` : said;
}

const STATE_ICON: Record<PendingWrite['state'], IconName> = {
  queued: 'clock',
  sending: 'upload-cloud',
  failed: 'alert-circle',
};

/** One queued write: what it is, where it stands, and (refused) why, with what can be done. */
export function PendingWriteRow({ item }: { item: PendingWrite }) {
  const { t } = useT();
  const { retry, discard } = useOutbox();
  const conflict =
    item.state === 'failed' && item.error?.status === 409 && item.error.code === 'stale';
  const label = pendingLabel(item, t);
  return (
    <View style={s.row}>
      <Icon
        name={STATE_ICON[item.state]}
        color={item.state === 'failed' ? colors.danger : colors.muted}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.text}>{label}</Text>
        <Text style={[styles.muted, item.state === 'failed' && { color: colors.danger }]}>
          {t(`offline.state.${item.state}`)}
          {item.state === 'failed' && item.error
            ? ` · ${conflict ? t('offline.conflict') : item.error.message}`
            : ''}
        </Text>
        <Text style={styles.muted}>{t('offline.when', { when: when(item.createdAt) })}</Text>
        {item.state === 'failed' && (
          <View style={[styles.row, { flexWrap: 'wrap', marginTop: space.xs }]}>
            <Button
              title={conflict ? t('offline.overwrite') : t('offline.retry')}
              icon="refresh-cw"
              variant="secondary"
              accessibilityLabel={`${conflict ? t('offline.overwrite') : t('offline.retry')}: ${label}`}
              onPress={() => void retry(item.id, { overwrite: conflict })}
            />
            <Button
              title={t('offline.discard')}
              icon="x"
              variant="subtle"
              accessibilityLabel={`${t('offline.discard')}: ${label}`}
              onPress={() => void discard(item.id)}
            />
          </View>
        )}
      </View>
    </View>
  );
}

/** The writes waiting on this device (all, or one entity's), each with its state. */
export function PendingWrites({ entity }: { entity?: string }) {
  const { items } = useOutbox();
  const shown = entity
    ? items.filter((i) => i.op.kind === 'entity' && i.op.entity === entity)
    : items;
  if (!shown.length) return null;
  return (
    <View style={[styles.card, { gap: space.md }]}>
      {shown.map((item) => (
        <PendingWriteRow key={item.id} item={item} />
      ))}
    </View>
  );
}

/**
 * The strip above the screen: offline, changes waiting or being sent, changes refused, or a
 * session to renew. Nothing when online and every change is saved.
 */
export function OfflineBanner() {
  const { t } = useT();
  const { online, syncing, paused, waiting, failed } = useOutbox();
  if (online && !waiting && !failed) return null;
  const parts = [
    !online
      ? t('offline.offline')
      : paused
        ? t('offline.signedOut')
        : syncing && waiting
          ? t('offline.syncing')
          : null,
    waiting ? t('offline.waiting', { count: waiting }) : null,
    failed ? t('offline.notSaved', { count: failed }) : null,
  ].filter(Boolean);
  const tone = failed ? s.bad : s.warn;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${parts.join('. ')}. ${t('offline.review')}`}
      accessibilityLiveRegion="polite"
      onPress={() => router.navigate('/offline')}
      style={[s.banner, tone]}
    >
      <Icon
        name={online ? 'upload-cloud' : 'wifi-off'}
        color={failed ? colors.danger : colors.warnText}
        size={16}
      />
      <Text style={[styles.label, { flex: 1, color: failed ? colors.danger : colors.warnText }]}>
        {parts.join(' · ')}
      </Text>
      <Text style={[styles.label, { color: failed ? colors.danger : colors.warnText }]}>
        {t('offline.review')}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderWidth: 1,
    borderRadius: 8,
    marginBottom: space.sm,
  },
  warn: { backgroundColor: colors.warnBg, borderColor: colors.warnBorder },
  bad: { backgroundColor: colors.dangerTint, borderColor: colors.danger },
});
