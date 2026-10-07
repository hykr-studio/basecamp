import { ApiError } from '@app/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router, Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { auth, type SessionUser } from '../api';
import { Button } from '../components/Button';
import { Chat } from '../components/Chat';
import { ApprovalCard } from '../framework/ApprovalCard';
import { AssistantProvider } from '../framework/assistant-context';
import { isHovered } from '../framework/hover';
import { Icon, type IconName } from '../framework/Icon';
import { ToastProvider } from '../framework/Toast';
import { SignIn } from '../screens/SignIn';
import { colors, space, styles } from '../theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // A refused request (4xx) is refused again; retry only what might be transient.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
    },
  },
});

const NAV: { href: string; label: string; icon: IconName; match: (path: string) => boolean }[] = [
  { href: '/', label: 'Today', icon: 'sun', match: (p) => p === '/' },
  {
    href: '/meetings',
    label: 'Meetings',
    icon: 'calendar',
    match: (p) => p.startsWith('/meetings'),
  },
  { href: '/notes', label: 'Notes', icon: 'file-text', match: (p) => p.startsWith('/notes') },
  { href: '/todos', label: 'To-dos', icon: 'check-square', match: (p) => p.startsWith('/todos') },
];

/** The parts of the page the browser draws: focus ring, selection, caret, themed from the palette. */
function useBrowserSurfaces() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.textContent = `
      ::selection { background: ${colors.primaryTint}; color: ${colors.text}; }
      input, textarea { caret-color: ${colors.primary}; }
      :focus-visible { outline: 2px solid ${colors.primary} !important; outline-offset: 2px; border-radius: 6px; }
      * { scrollbar-color: #c3c9d3 transparent; }
    `;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
}

function NavItem({
  item,
  active,
  vertical,
}: {
  item: (typeof NAV)[number];
  active: boolean;
  vertical: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityState={{ selected: active }}
      accessibilityLabel={item.label}
      onPress={() => router.navigate(item.href)}
      style={(state) => [
        vertical ? s.railItem : s.tabItem,
        active && (vertical ? s.railActive : null),
        isHovered(state) && !active && vertical && { backgroundColor: '#e2e6ec' },
      ]}
    >
      <Icon
        name={item.icon}
        color={active ? colors.primary : colors.muted}
        size={vertical ? 18 : 20}
      />
      <Text
        style={[
          vertical ? s.railLabel : s.tabLabel,
          { color: active ? colors.primary : colors.muted },
        ]}
      >
        {item.label}
      </Text>
    </Pressable>
  );
}

function Shell({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const wide = useWindowDimensions().width >= 900;
  const path = usePathname();
  const [chatOpen, setChatOpen] = useState(false);
  const chatKey = `chat:${user.id}`;
  const stack = (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );

  if (wide) {
    return (
      <View style={[styles.screen, { flexDirection: 'row' }]}>
        <View style={s.rail} role="navigation">
          <View style={{ gap: 2, paddingHorizontal: space.md, paddingBottom: space.lg }}>
            <Text style={styles.heading}>Meetings</Text>
            <Text style={styles.muted}>Agentic stack template</Text>
          </View>
          {NAV.map((n) => (
            <NavItem key={n.href} item={n} active={n.match(path)} vertical />
          ))}
          <View style={{ flex: 1 }} />
          <View style={{ gap: space.xs, paddingHorizontal: space.md }}>
            <Text style={styles.label} numberOfLines={1}>
              {user.name}
            </Text>
            <Text style={styles.muted} numberOfLines={1}>
              {user.email}
            </Text>
          </View>
          <Button title="Sign out" icon="log-out" variant="subtle" onPress={onSignOut} />
        </View>
        <View style={{ flex: 1 }}>
          <View
            style={{
              paddingHorizontal: space.lg,
              paddingTop: space.lg,
              width: '100%',
              maxWidth: 960,
              alignSelf: 'center',
            }}
          >
            <ApprovalCard />
          </View>
          {stack}
        </View>
        <View style={{ width: 380, padding: space.lg, paddingLeft: 0 }}>
          <Chat storageKey={chatKey} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={s.topBar}>
        <Text style={styles.heading}>Meetings</Text>
        <Button
          title={`Sign out ${user.name}`}
          icon="log-out"
          iconOnly
          variant="subtle"
          onPress={onSignOut}
        />
      </View>
      <View style={{ flex: 1 }}>{stack}</View>
      <ApprovalCard variant="dock" />
      {/* Kept mounted so the conversation survives closing the panel. */}
      <View style={[{ height: '55%' }, !chatOpen && { display: 'none' }]}>
        <Chat storageKey={chatKey} compact />
      </View>
      <View style={s.tabBar} role="navigation">
        {NAV.map((n) => (
          <NavItem key={n.href} item={n} active={n.match(path) && !chatOpen} vertical={false} />
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: chatOpen }}
          accessibilityLabel={chatOpen ? 'Hide the assistant' : 'Open the assistant'}
          onPress={() => setChatOpen(!chatOpen)}
          style={s.tabItem}
        >
          <Icon name="message-circle" color={chatOpen ? colors.primary : colors.muted} size={20} />
          <Text style={[s.tabLabel, { color: chatOpen ? colors.primary : colors.muted }]}>
            Assistant
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function RootLayout() {
  useBrowserSurfaces();
  // undefined while the session loads, null when signed out.
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  useEffect(() => {
    auth
      .me()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AssistantProvider>
          <StatusBar style="dark" />
          {user === undefined ? (
            <ActivityIndicator
              style={{ marginTop: 96 }}
              color={colors.primary}
              accessibilityLabel="Loading your session"
            />
          ) : user === null ? (
            <View style={styles.screen}>
              <SignIn onSignedIn={setUser} />
            </View>
          ) : (
            <Shell
              user={user}
              onSignOut={() => {
                auth.signOut().finally(() => {
                  queryClient.clear();
                  setUser(null);
                });
              }}
            />
          )}
        </AssistantProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

const s = StyleSheet.create({
  rail: {
    width: 228,
    backgroundColor: colors.rail,
    paddingVertical: space.lg,
    paddingHorizontal: space.sm,
    gap: space.xs,
  },
  railItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: 8,
  },
  railActive: { backgroundColor: colors.card },
  railLabel: { fontSize: 15, fontWeight: '600' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: space.lg,
    paddingRight: space.xs,
    minHeight: 52,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingBottom: space.xs,
  },
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, minHeight: 56 },
  tabLabel: { fontSize: 12, fontWeight: '600' },
});
