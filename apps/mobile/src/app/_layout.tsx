import '../../global.css';
import { ApiError } from '@app/api-client';
import {
  SchibstedGrotesk_600SemiBold,
  SchibstedGrotesk_700Bold,
  useFonts,
} from '@expo-google-fonts/schibsted-grotesk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router, Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { auth, type SessionUser } from '../api';
import { Canvas } from '../canvas/Canvas';
import { bindPlatformScreens } from '../canvas/screens';
import { useCanvas } from '../canvas/store';
import { ChatRuntime } from '../chat/ChatRuntime';
import { Thread } from '../chat/Thread';
import { Button } from '../components/Button';
import { WhatsAppLink } from '../components/WhatsAppLink';
import { appDomain } from '../domain';
import { ApprovalCard } from '../framework/ApprovalCard';
import { ASSISTANT_ICON } from '../framework/AssistantMark';
import type { NavItem as Destination } from '../framework/app-domain';
import { AssistantProvider } from '../framework/assistant-context';
import { isHovered } from '../framework/hover';
import { Icon } from '../framework/Icon';
import { LangProvider } from '../framework/lang';
import { ToastProvider } from '../framework/Toast';
import { SignIn } from '../screens/SignIn';
import { colors, space, styles } from '../theme';
import { bindPlatformViews } from '../views';
import { VoiceStrip } from '../voice/VoiceBar';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // A refused request (4xx) is refused again; retry only what might be transient.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
    },
  },
});

/** The domain's destinations, then the framework's own. */
const NAV: Destination[] = [
  ...appDomain.nav,
  { href: '/pages', label: 'Pages', icon: 'layout', match: (p) => p.startsWith('/pages') },
];

// Bind this app's components to every registered view and canvas screen, once.
bindPlatformViews();
bindPlatformScreens();
appDomain.bind();

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
  item: Destination;
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
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const canvasOpen = useCanvas((c) => c.state.kind !== 'closed');
  const closeCanvas = useCanvas((c) => c.close);
  const stack = (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );

  if (wide) {
    return (
      <View style={[styles.screen, { flexDirection: 'row' }]}>
        <View style={s.rail} role="navigation">
          <View style={{ gap: 2, paddingHorizontal: space.md, paddingBottom: space.lg }}>
            <Text style={styles.heading}>Agentic Stack</Text>
            <Text style={styles.muted}>{appDomain.tagline}</Text>
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
            <WhatsAppLink />
          </View>
          <Button title="Sign out" icon="log-out" variant="subtle" onPress={onSignOut} />
        </View>
        {/* The canvas takes the main column's place; the person's screen stays mounted under it. */}
        {canvasOpen && (
          <View style={{ flex: 1 }}>
            <Canvas />
          </View>
        )}
        <View style={[{ flex: 1 }, canvasOpen && { display: 'none' }]} role="main">
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
          <Thread />
        </View>
      </View>
    );
  }

  return (
    // Phones: content stays clear of the notch and the home indicator (no-op on the web).
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {/* The whole layout rises with the keyboard, so the message box stays above it. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.topBar}>
          <Text style={styles.heading}>Agentic Stack</Text>
          {confirmSignOut ? (
            <View style={styles.row}>
              <Button title="Stay" variant="subtle" onPress={() => setConfirmSignOut(false)} />
              <Button title="Sign out" variant="secondary" icon="log-out" onPress={onSignOut} />
            </View>
          ) : (
            <Button
              title={`Sign out ${user.name}`}
              icon="log-out"
              iconOnly
              variant="subtle"
              onPress={() => setConfirmSignOut(true)}
            />
          )}
        </View>
        <View style={{ flex: 1 }} role="main">
          {stack}
          {/* A canvas intent opens as a sheet over the screen, between the top bar and the
            tabs (so clear of the notch); "Chat" goes back to the thread. */}
          {canvasOpen && (
            <View style={StyleSheet.absoluteFill}>
              <Canvas
                onChat={() => {
                  closeCanvas();
                  setChatOpen(true);
                }}
              />
            </View>
          )}
        </View>
        {/* One bottom surface at a time: the assistant sheet replaces the approvals dock. */}
        <ApprovalCard variant="dock" hidden={chatOpen || canvasOpen} />
        {/* The conversation lives in ChatRuntime, so the sheet can unmount when closed. */}
        {chatOpen && !canvasOpen && (
          <View style={{ height: '60%' }}>
            <Thread compact onClose={() => setChatOpen(false)} />
          </View>
        )}
        {/* Voice goes on with the sheet closed: keep it in sight, and a way to end it. */}
        {!(chatOpen && !canvasOpen) && (
          <VoiceStrip
            onOpen={() => {
              closeCanvas();
              setChatOpen(true);
            }}
          />
        )}
        <View style={s.tabBar} role="navigation">
          {NAV.map((n) => (
            <NavItem key={n.href} item={n} active={n.match(path) && !chatOpen} vertical={false} />
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: chatOpen }}
            accessibilityLabel={chatOpen ? 'Hide the assistant' : 'Open the assistant'}
            onPress={() => {
              // From the canvas, the Assistant tab goes back to the thread.
              if (canvasOpen) closeCanvas();
              setChatOpen(canvasOpen || !chatOpen);
            }}
            style={s.tabItem}
          >
            <Icon
              name={ASSISTANT_ICON}
              color={chatOpen ? colors.primary : colors.muted}
              size={20}
            />
            <Text style={[s.tabLabel, { color: chatOpen ? colors.primary : colors.muted }]}>
              Assistant
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function RootLayout() {
  useBrowserSurfaces();
  // Headings' face. If it fails to load, the platform font stands in; nothing waits on it twice.
  const [fontsLoaded, fontError] = useFonts({
    SchibstedGrotesk_600SemiBold,
    SchibstedGrotesk_700Bold,
  });
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
        <LangProvider>
          <AssistantProvider>
            <StatusBar style="dark" />
            {user === undefined || !(fontsLoaded || fontError) ? (
              <View style={styles.screen}>
                <ActivityIndicator
                  style={{ marginTop: 96 }}
                  color={colors.primary}
                  accessibilityLabel="Loading your session"
                />
              </View>
            ) : user === null ? (
              <View style={styles.screen}>
                <SignIn onSignedIn={setUser} />
              </View>
            ) : (
              <ChatRuntime key={user.id}>
                <Shell
                  user={user}
                  onSignOut={() => {
                    auth.signOut().finally(() => {
                      queryClient.clear();
                      setUser(null);
                    });
                  }}
                />
              </ChatRuntime>
            )}
          </AssistantProvider>
        </LangProvider>
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
