import type { CalendarConnectionInfo, CalendarFeedInfo } from '@hykr/contracts';
import { useEffect, useState } from 'react';
import { Linking, Platform, ScrollView, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { ScreenTitle, SectionHeading } from '../../components/ScreenTitle';
import { useScreenContext } from '../../framework/assistant-context';
import { when } from '../../framework/dates';
import { LoadError } from '../../framework/EmptyState';
import { errorMessage } from '../../framework/hooks';
import { Icon } from '../../framework/Icon';
import { Loading } from '../../framework/Loading';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { colors, space, styles } from '../../theme';
import {
  useCalendarConnections,
  useCalendarFeeds,
  useCalendarProviders,
  useConnectCalendar,
  useCreateFeed,
  useDisconnectCalendar,
  useRevokeFeed,
} from './hooks';

/** Copy text where the platform lets a page do it (the web); elsewhere the text is selectable. */
const clipboard = () =>
  Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.clipboard : undefined;

function ConnectionRow({ c }: { c: CalendarConnectionInfo }) {
  const { t } = useT();
  const toast = useToast();
  const disconnect = useDisconnectCalendar();
  return (
    <View style={[styles.row, { gap: space.sm, paddingVertical: space.xs }]}>
      <Icon name="calendar" color={c.status === 'active' ? colors.primary : colors.danger} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.text}>{c.account}</Text>
        <Text style={styles.muted}>
          {c.status === 'needs_reauth'
            ? t('calendar.needsReauth')
            : c.lastSyncedAt
              ? t('calendar.lastSynced', { when: when(c.lastSyncedAt) })
              : 'Google'}
        </Text>
      </View>
      <Button
        title={t('calendar.disconnect')}
        variant="ghost"
        busy={disconnect.isPending}
        onPress={() =>
          disconnect.mutate(c.id, {
            onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
          })
        }
      />
    </View>
  );
}

function Connections() {
  const { t } = useT();
  const toast = useToast();
  const providers = useCalendarProviders();
  const connections = useCalendarConnections();
  const connect = useConnectCalendar();
  const offered = providers.data?.some((p) => p.name === 'google' && p.available) ?? false;
  const has = (connections.data ?? []).length > 0;
  return (
    <View style={{ gap: space.sm }}>
      <SectionHeading>{t('calendar.connections')}</SectionHeading>
      {connections.error ? (
        <LoadError what="your calendars" onRetry={() => connections.refetch()} />
      ) : !connections.data ? (
        <Loading />
      ) : (
        connections.data.map((c) => <ConnectionRow key={c.id} c={c} />)
      )}
      {!offered ? (
        <Text style={styles.muted}>{t('calendar.notOffered')}</Text>
      ) : (
        <View style={styles.row}>
          <Button
            title={t('calendar.connectGoogle')}
            icon="link"
            variant={has ? 'secondary' : 'primary'}
            busy={connect.isPending}
            onPress={() =>
              connect.mutate(undefined, {
                onSuccess: ({ url }) => void Linking.openURL(url),
                onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
              })
            }
          />
        </View>
      )}
    </View>
  );
}

function FeedRow({ f }: { f: CalendarFeedInfo }) {
  const { t } = useT();
  const revoke = useRevokeFeed();
  return (
    <View style={[styles.row, { gap: space.sm, paddingVertical: space.xs }]}>
      <Icon name="rss" color={colors.muted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.text}>{f.label ?? when(f.createdAt)}</Text>
        {f.lastUsedAt && <Text style={styles.muted}>{when(f.lastUsedAt)}</Text>}
      </View>
      <Button
        title={t('calendar.revoke')}
        variant="ghost"
        busy={revoke.isPending}
        onPress={() => revoke.mutate(f.id)}
      />
    </View>
  );
}

function Feeds() {
  const { t } = useT();
  const toast = useToast();
  const feeds = useCalendarFeeds();
  const create = useCreateFeed();
  const [made, setMade] = useState<string | null>(null);
  const copy = clipboard();
  return (
    <View style={{ gap: space.sm }}>
      <SectionHeading>{t('calendar.feeds')}</SectionHeading>
      <Text style={styles.muted}>{t('calendar.feedsHint')}</Text>
      {(feeds.data ?? []).map((f) => (
        <FeedRow key={f.id} f={f} />
      ))}
      {made && (
        <View style={{ gap: space.xs }}>
          <Text style={styles.label}>{t('calendar.feedReady')}</Text>
          <Text style={styles.text} selectable>
            {made}
          </Text>
          {copy && (
            <View style={styles.row}>
              <Button
                title={t('calendar.copy')}
                icon="copy"
                variant="secondary"
                onPress={() => void copy.writeText(made)}
              />
            </View>
          )}
        </View>
      )}
      <View style={styles.row}>
        <Button
          title={t('calendar.newFeed')}
          icon="plus"
          variant="secondary"
          busy={create.isPending}
          onPress={() =>
            create.mutate(undefined, {
              onSuccess: (out) => setMade(out.url ?? null),
              onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
            })
          }
        />
      </View>
    </View>
  );
}

/**
 * The person's calendars (`/calendar`): connect Google, see when it last synced, disconnect;
 * make, copy and revoke private feed links. Google sends the browser back here
 * (`?connected=google` or `?error=`).
 */
export function CalendarScreen() {
  useScreenContext({ screen: 'calendar' });
  const { t } = useT();
  const toast = useToast();
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    if (q.get('connected')) toast.show({ message: t('calendar.connected'), tone: 'success' });
    else if (q.get('error')) toast.show({ message: q.get('error') ?? '', tone: 'error' });
  }, [t, toast]);
  return (
    <ScrollView contentContainerStyle={[styles.content, { gap: space.lg }]}>
      <ScreenTitle title={t('calendar.title')} />
      <Connections />
      <Feeds />
    </ScrollView>
  );
}
