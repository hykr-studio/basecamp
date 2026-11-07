import type { CalendarConnectionInfo, CalendarFeedInfo } from '@hykr/contracts';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
  useCompleteCalendar,
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

type Param = string | string[] | undefined;
const first = (v: Param) => (Array.isArray(v) ? v[0] : v) ?? '';

/**
 * Back from Google (`?code=&state=`, or `?error=`): the sign-in is finished here, once, under
 * this app's session (the server refuses it to anyone but the person who started it), and the
 * address is cleared after.
 */
function useFinishSignIn(): boolean {
  const { t } = useT();
  const toast = useToast();
  const complete = useCompleteCalendar();
  const params = useLocalSearchParams<{ code?: string; state?: string; error?: string }>();
  const code = first(params.code as Param);
  const state = first(params.state as Param);
  const error = first(params.error as Param);
  const seen = useRef('');
  const { mutate } = complete;
  useEffect(() => {
    if (!error && !(code && state)) return;
    const key = `${state}|${error}`;
    if (seen.current === key) return;
    seen.current = key;
    const clear = () => router.replace('/calendar' as never);
    if (error) {
      toast.show({ message: t('calendar.signInStopped', { reason: error }), tone: 'error' });
      clear();
      return;
    }
    mutate(
      { code, state },
      {
        onSuccess: () => toast.show({ message: t('calendar.connected'), tone: 'success' }),
        onError: (e) =>
          toast.show({
            message: t('calendar.signInStopped', { reason: errorMessage(e) }),
            tone: 'error',
          }),
        onSettled: clear,
      },
    );
  }, [code, state, error, mutate, t, toast]);
  return complete.isPending;
}

/**
 * The person's calendars (`/calendar`): connect Google, see when it last synced, disconnect;
 * make, copy and revoke private feed links. Google sends the browser back here, through the
 * API, with a code and a state that this screen finishes connecting with.
 */
export function CalendarScreen() {
  useScreenContext({ screen: 'calendar' });
  const { t } = useT();
  const finishing = useFinishSignIn();
  return (
    <ScrollView contentContainerStyle={[styles.content, { gap: space.lg }]}>
      <ScreenTitle title={t('calendar.title')} />
      {finishing && <Text style={styles.muted}>{t('calendar.connecting')}</Text>}
      <Connections />
      <Feeds />
    </ScrollView>
  );
}
