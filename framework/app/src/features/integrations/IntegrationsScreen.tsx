import type { ConnectionInfo, ConnectorInfo } from '@hykr/contracts';
import { pick } from '@hykr/i18n';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { ScreenTitle, SectionHeading } from '../../components/ScreenTitle';
import { useScreenContext } from '../../framework/assistant-context';
import { LoadError } from '../../framework/EmptyState';
import { errorMessage } from '../../framework/hooks';
import { Icon } from '../../framework/Icon';
import { Loading } from '../../framework/Loading';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { colors, space, styles } from '../../theme';
import {
  useCompleteSignIn,
  useConnections,
  useConnectors,
  useDisconnect,
  usePickAccounts,
  useStartSignIn,
} from './hooks';

/** Open the provider's consent screen for a connector (or a connection, signing it in again). */
function useSignIn() {
  const toast = useToast();
  const start = useStartSignIn();
  return {
    busy: start.isPending,
    open: (connector: string, connectionId?: string) =>
      start.mutate(
        { connector, ...(connectionId ? { connectionId } : {}) },
        {
          onSuccess: ({ url }) => void Linking.openURL(url),
          onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
        },
      ),
  };
}

/** The pages a signed-in connection was offered: tick the ones it receives events for. */
function Accounts({ c }: { c: ConnectionInfo }) {
  const { t } = useT();
  const toast = useToast();
  const save = usePickAccounts();
  const accounts = c.accounts ?? [];
  const [chosen, setChosen] = useState(
    () => new Set(accounts.filter((a) => a.held).map((a) => a.id)),
  );
  if (!accounts.length) return null;
  const toggle = (id: string) =>
    setChosen((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <View style={{ gap: space.xs, paddingLeft: space.lg }}>
      <Text style={styles.label}>{t('integrations.accounts')}</Text>
      {accounts.map((a) => (
        <Pressable
          key={a.id}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: chosen.has(a.id) }}
          onPress={() => toggle(a.id)}
          style={[styles.row, { gap: space.sm }]}
        >
          <Icon name={chosen.has(a.id) ? 'check-square' : 'square'} color={colors.primary} />
          <Text style={styles.text}>{a.name}</Text>
        </Pressable>
      ))}
      <View style={styles.row}>
        <Button
          title={t('integrations.saveAccounts')}
          variant="secondary"
          busy={save.isPending}
          onPress={() =>
            save.mutate(
              { id: c.id, accountIds: [...chosen] },
              {
                onSuccess: (out) => {
                  const failed = (out.subscribed ?? []).filter((s) => !s.ok);
                  toast.show(
                    failed.length
                      ? { message: t('integrations.someNotSubscribed'), tone: 'error' }
                      : { message: t('integrations.accountsSaved'), tone: 'success' },
                  );
                },
                onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
              },
            )
          }
        />
      </View>
    </View>
  );
}

/** One connection: what it is, whether it works, sign in again, disconnect. */
function ConnectionRow({ c, connector }: { c: ConnectionInfo; connector?: ConnectorInfo }) {
  const { t, lang } = useT();
  const toast = useToast();
  const disconnect = useDisconnect();
  const signIn = useSignIn();
  const name = c.label ?? (connector ? pick(connector.label, lang) : c.connector);
  const state =
    c.status === 'needs_reauth'
      ? t('integrations.needsReauthRow')
      : c.status === 'disabled'
        ? t('integrations.disconnectedRow')
        : t('integrations.connectedRow');
  return (
    <View style={{ gap: space.xs, paddingVertical: space.xs }}>
      <View style={[styles.row, { gap: space.sm }]}>
        <Icon name="link" color={c.status === 'active' ? colors.primary : colors.danger} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.text}>{name}</Text>
          <Text style={styles.muted}>{state}</Text>
        </View>
        {c.auth === 'oauth' && c.status === 'needs_reauth' && (
          <Button
            title={t('integrations.reconnect')}
            variant="secondary"
            busy={signIn.busy}
            onPress={() => signIn.open(c.connector, c.id)}
          />
        )}
        <Button
          title={t('integrations.disconnect')}
          variant="ghost"
          busy={disconnect.isPending}
          onPress={() =>
            disconnect.mutate(c.id, {
              onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
            })
          }
        />
      </View>
      {c.auth === 'oauth' && connector?.oauth?.pick && <Accounts c={c} />}
    </View>
  );
}

type Param = string | string[] | undefined;
const first = (v: Param) => (Array.isArray(v) ? v[0] : v) ?? '';

/**
 * Back from the provider (`?code=&state=`, or `?error=`): the sign-in is finished here, once,
 * under this app's session (the server refuses it to anyone but the person who started it), and
 * the address is cleared after.
 */
function useFinishSignIn(): boolean {
  const { t } = useT();
  const toast = useToast();
  const complete = useCompleteSignIn();
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
    const clear = () => router.replace('/integrations' as never);
    if (error) {
      toast.show({ message: t('integrations.signInStopped', { reason: error }), tone: 'error' });
      clear();
      return;
    }
    mutate(
      { code, state },
      {
        onSuccess: () => toast.show({ message: t('integrations.connected'), tone: 'success' }),
        onError: (e) =>
          toast.show({
            message: t('integrations.signInStopped', { reason: errorMessage(e) }),
            tone: 'error',
          }),
        onSettled: clear,
      },
    );
  }, [code, state, error, mutate, t, toast]);
  return complete.isPending;
}

/**
 * The business's connections (`/integrations`), for people who manage integrations: a Connect
 * button per connector that signs in, each connection's state (connected, needs signing in
 * again, disconnected), its pages to pick, and disconnect. Providers send the browser back here,
 * through the API, with a code and a state this screen finishes with. A screen per connector is
 * not here (developer guide, section 14).
 */
export function IntegrationsScreen() {
  useScreenContext({ screen: 'integrations' });
  const { t, lang } = useT();
  const finishing = useFinishSignIn();
  const connectors = useConnectors();
  const connections = useConnections();
  const signIn = useSignIn();
  const byName = new Map((connectors.data ?? []).map((c) => [c.name, c]));
  const signsIn = (connectors.data ?? []).filter((c) => c.oauth);
  return (
    <ScrollView contentContainerStyle={[styles.content, { gap: space.lg }]}>
      <ScreenTitle title={t('integrations.title')} />
      {finishing && <Text style={styles.muted}>{t('integrations.connecting')}</Text>}
      <View style={{ gap: space.sm }}>
        <SectionHeading>{t('integrations.connections')}</SectionHeading>
        {connections.error ? (
          <LoadError what="the connections" onRetry={() => connections.refetch()} />
        ) : !connections.data ? (
          <Loading />
        ) : connections.data.length === 0 ? (
          <Text style={styles.muted}>{t('integrations.none')}</Text>
        ) : (
          connections.data.map((c) => (
            <ConnectionRow key={c.id} c={c} connector={byName.get(c.connector)} />
          ))
        )}
      </View>
      {signsIn.length > 0 && (
        <View style={{ gap: space.sm }}>
          <SectionHeading>{t('integrations.connectNew')}</SectionHeading>
          {signsIn.map((c) => (
            <View key={c.name} style={[styles.row, { gap: space.sm }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.text}>{pick(c.label, lang)}</Text>
                {c.description && <Text style={styles.muted}>{pick(c.description, lang)}</Text>}
              </View>
              {c.oauth?.available ? (
                <Button
                  title={t('integrations.connect')}
                  icon="link"
                  busy={signIn.busy}
                  onPress={() => signIn.open(c.name)}
                />
              ) : (
                <Text style={styles.muted}>{t('integrations.notOffered')}</Text>
              )}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
