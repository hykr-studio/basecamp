import {
  SchibstedGrotesk_600SemiBold,
  SchibstedGrotesk_700Bold,
  useFonts,
} from '@expo-google-fonts/schibsted-grotesk';
import { ApiError } from '@hykr/api-client';
import type { Catalog } from '@hykr/contracts';
import type { Registry } from '@hykr/ui-registry';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router, Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { type ReactNode, useEffect, useState } from 'react';
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
import { auth, type SessionUser } from './api';
import { Canvas } from './canvas/Canvas';
import { bindPlatformScreens } from './canvas/screens';
import { useCanvas } from './canvas/store';
import { ChatRuntime } from './chat/ChatRuntime';
import { Thread } from './chat/Thread';
import { Button } from './components/Button';
import { WhatsAppLink } from './components/WhatsAppLink';
import { type AppConfig, configure } from './config';
import { ApprovalCard } from './framework/ApprovalCard';
import { ApprovalsAnnouncer } from './framework/ApprovalsAnnouncer';
import { ASSISTANT_ICON } from './framework/AssistantMark';
import type {
  AppModule,
  AppPlugin,
  AppSettings,
  NavItem as Destination,
} from './framework/app-domain';
import { AssistantProvider, useAssistant } from './framework/assistant-context';
import { bindAll, composeApp, type ModuleList, matchRoute } from './framework/compose-app';
import { isFocused, isHovered } from './framework/hover';
import { Icon } from './framework/Icon';
import { LangProvider } from './framework/lang';
import { SignedIn, useNavFilters, wrapProviders } from './framework/plugins';
import { ToastProvider } from './framework/Toast';
import { inApp, webHref } from './framework/web-link';
import { getApp, setRuntime } from './runtime';
import { SignIn } from './screens/SignIn';
import { colors, space, styles } from './theme';
import { bindPlatformViews } from './views';
import { VoiceStrip } from './voice/VoiceBar';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // A refused request (4xx) is refused again; retry only what might be transient.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
    },
  },
});

/**
 * What the application passes in: its own settings (`app`: name, home screen), its app modules,
 * the framework plugins it uses, and the catalog and registry it built from its modules' specs
 * and views. `modules` may be a list or the namespace of a barrel (`import * as modules`).
 * `config` carries what the app read from its environment.
 */
export type AppShellProps = {
  app: AppSettings;
  modules: ModuleList;
  plugins?: readonly AppPlugin[];
  catalog: Catalog;
  registry: Registry;
  config?: Partial<AppConfig>;
};

type Installed = {
  app: AppSettings;
  modules: readonly AppModule[];
  plugins: readonly AppPlugin[];
  catalog: Catalog;
  registry: Registry;
  /** Counts installations: the shell remounts on a new one, so plugin hooks keep their order. */
  generation: number;
};
let installed: Installed | undefined;

const listOf = (modules: ModuleList): readonly AppModule[] =>
  Array.isArray(modules)
    ? (modules as readonly AppModule[])
    : Object.keys(modules)
        .sort()
        .map((k) => (modules as Readonly<Record<string, AppModule>>)[k]);
const sameList = <T,>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Composes the application's settings, modules and plugins (refusing any collision), hands the
 * result, the catalog and the registry to the framework, and binds every component to its view
 * or screen. Again only when one of them changes (Fast Refresh): the same members in a new list
 * do nothing.
 */
function install(props: AppShellProps): Installed {
  const modules = listOf(props.modules);
  const plugins = props.plugins ?? [];
  if (
    installed &&
    installed.app === props.app &&
    installed.catalog === props.catalog &&
    installed.registry === props.registry &&
    sameList(installed.modules, modules) &&
    sameList(installed.plugins, plugins)
  )
    return installed;
  if (props.config) configure(props.config);
  const app = composeApp({
    app: props.app,
    modules: props.modules,
    plugins,
    catalog: props.catalog,
  });
  setRuntime({ catalog: props.catalog, registry: props.registry, app });
  bindAll(
    [
      {
        owner: 'framework',
        bind: () => {
          bindPlatformViews();
          bindPlatformScreens();
        },
      },
      ...app.modules.map((m) => ({ owner: m.name, bind: m.bind })),
    ],
    props.registry,
  );
  installed = {
    app: props.app,
    modules,
    plugins,
    catalog: props.catalog,
    registry: props.registry,
    generation: (installed?.generation ?? 0) + 1,
  };
  return installed;
}

/** Signed out on a plugin's public route: that screen alone, without the shell. */
function PublicRoute({ fallback }: { fallback: ReactNode }) {
  const path = usePathname();
  const hit = matchRoute(
    getApp().routes.filter((r) => r.public),
    path,
  );
  if (!hit) return fallback;
  const Screen = hit.route.screen;
  return (
    <View style={styles.screen}>
      <Screen params={hit.params} />
    </View>
  );
}

/**
 * The public route gate (decisions B9): a plugin's standalone route (a share link's page) is
 * drawn on its own for everyone, signed in or not, before any session is looked for.
 */
function standaloneRoute(path: string) {
  return matchRoute(
    getApp().routes.filter((r) => r.public && r.standalone),
    path,
  );
}

/** The business's mark when a plugin draws one (the settings plugin's logo and name), else the title. */
function Brand({ fallback }: { fallback: string }) {
  const Mark = getApp().plugins.find((p) => p.Brand)?.Brand;
  return Mark ? <Mark fallback={fallback} /> : <Text style={styles.heading}>{fallback}</Text>;
}

/** The parts of the page the browser draws: focus ring, selection, caret, themed from the palette. */
function useBrowserSurfaces() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.textContent = `
      ::selection { background: ${colors.primaryTint}; color: ${colors.text}; }
      input, textarea { caret-color: ${colors.primary}; }
      :focus-visible { outline: 2px solid ${colors.primary} !important; outline-offset: 2px; border-radius: 6px; }
      * { scrollbar-color: ${colors.scrollbar} transparent; }
      /* The skip link's target takes focus without a ring around the whole column. */
      #main:focus-visible, #canvas:focus-visible { outline: none !important; }
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
      // A real anchor on the web, so Enter follows it.
      {...webHref(item.href)}
      onPress={inApp(() => router.navigate(item.href))}
      style={(state) => [
        vertical ? s.railItem : s.tabItem,
        active && (vertical ? s.railActive : null),
        isHovered(state) && !active && vertical && { backgroundColor: colors.railHover },
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

/** Shows the full text on hover (web), where a single line cuts it short. */
const withTitle = (title: string) => (node: unknown) => {
  if (Platform.OS === 'web' && node instanceof HTMLElement) node.title = title;
};

/**
 * The first stop for Tab on the web: past the navigation to the screen itself. Hidden until
 * it has keyboard focus. With the canvas open on a wide screen, the canvas is the content.
 */
function SkipLink() {
  if (Platform.OS !== 'web') return null;
  return (
    <Pressable
      accessibilityRole="link"
      {...webHref('#main')}
      onPress={inApp(() => {
        const target = [document.getElementById('main'), document.getElementById('canvas')].find(
          (el) => el && el.offsetParent !== null,
        );
        if (!target) return;
        target.setAttribute('tabindex', '-1');
        target.focus();
      })}
      style={(state) => (isFocused(state) ? [s.skip, s.skipShown] : s.skip)}
    >
      <Text style={[styles.label, { color: colors.primary }]}>Skip to content</Text>
    </Pressable>
  );
}

function Shell({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const app = getApp();
  // The plugins' nav filters (flags, roles) may hide destinations, never add one.
  const nav = useNavFilters(app.nav, app.plugins);
  const wide = useWindowDimensions().width >= 900;
  const path = usePathname();
  const [chatOpen, setChatOpen] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const canvasOpen = useCanvas((c) => c.state.kind !== 'closed');
  const closeCanvas = useCanvas((c) => c.close);
  const { registerReveal } = useAssistant();
  // A screen's "Try: …" prompt opens the phone's sheet so the reply is in sight; wide
  // layouts always show the thread.
  useEffect(() => {
    registerReveal(
      wide
        ? () => {}
        : () => {
            closeCanvas();
            setChatOpen(true);
          },
    );
  }, [wide, registerReveal, closeCanvas]);
  const stack = (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );

  if (wide) {
    return (
      <View style={[styles.screen, { flexDirection: 'row' }]}>
        <SkipLink />
        <ApprovalsAnnouncer />
        <View style={s.rail} role="navigation">
          <View style={{ gap: 2, paddingHorizontal: space.md, paddingBottom: space.lg }}>
            <Brand fallback={app.title} />
            <Text style={styles.muted}>{app.tagline}</Text>
          </View>
          {nav.map((n) => (
            <NavItem key={n.href} item={n} active={n.match(path)} vertical />
          ))}
          <View style={{ flex: 1 }} />
          <View style={{ gap: space.xs, paddingHorizontal: space.md }}>
            <Text style={styles.label} numberOfLines={1}>
              {user.name}
            </Text>
            <Text
              ref={withTitle(user.email)}
              style={styles.muted}
              numberOfLines={1}
              accessibilityLabel={user.email}
            >
              {user.email}
            </Text>
            <WhatsAppLink />
          </View>
          <Button title="Sign out" icon="log-out" variant="subtle" onPress={onSignOut} />
        </View>
        {/* The canvas takes the main column's place; the person's screen stays mounted under it. */}
        {canvasOpen && (
          <View style={{ flex: 1 }} id="canvas">
            <Canvas />
          </View>
        )}
        <View style={[{ flex: 1 }, canvasOpen && { display: 'none' }]} role="main" id="main">
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
        <SkipLink />
        <ApprovalsAnnouncer />
        <View style={s.topBar}>
          <Brand fallback={app.title} />
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
        <View style={{ flex: 1 }} role="main" id="main">
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
          {nav.map((n) => (
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

/**
 * The whole app around the application's routes: sign-in, the navigation rail or tab bar,
 * the assistant's thread, the canvas and approvals. An application's root _layout renders it.
 */
export function AppShell(props: AppShellProps) {
  // Before anything below renders: they read the catalog, the registry and the composed app.
  const { generation } = install(props);
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
  const standalone = standaloneRoute(usePathname());
  const Standalone = standalone?.route.screen;

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <LangProvider>
          <AssistantProvider>
            <StatusBar style="dark" />
            {wrapProviders(
              getApp().plugins,
              Standalone && standalone ? (
                <View style={styles.screen}>
                  <Standalone params={standalone.params} />
                </View>
              ) : user === undefined || !(fontsLoaded || fontError) ? (
                <View style={styles.screen}>
                  <ActivityIndicator
                    style={{ marginTop: 96 }}
                    color={colors.primary}
                    accessibilityLabel="Loading your session"
                  />
                </View>
              ) : user === null ? (
                <PublicRoute
                  fallback={
                    <View style={styles.screen}>
                      <SignIn onSignedIn={setUser} />
                    </View>
                  }
                />
              ) : (
                <ChatRuntime key={user.id}>
                  {/* Its one child, keyed by installation: a new one unmounts the old shell and
                      runs the old plugins' sign-out cleanups before the new ones sign in. */}
                  <SignedIn key={generation} user={user} plugins={getApp().plugins}>
                    <Shell
                      user={user}
                      onSignOut={() => {
                        auth.signOut().finally(() => {
                          queryClient.clear();
                          setUser(null);
                        });
                      }}
                    />
                  </SignedIn>
                </ChatRuntime>
              ),
            )}
          </AssistantProvider>
        </LangProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

const s = StyleSheet.create({
  // Off screen until focused; then a small card at the top left, above everything.
  skip: { position: 'absolute', left: -10000, top: space.sm, zIndex: 10 },
  skipShown: {
    left: space.sm,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
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
