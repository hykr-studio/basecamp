import {
  SchibstedGrotesk_600SemiBold,
  SchibstedGrotesk_700Bold,
  useFonts,
} from '@expo-google-fonts/schibsted-grotesk';
import { type ApiClient, ApiError } from '@hykr/api-client';
import { FrameworkCapabilities, SupportConsentCapability } from '@hykr/contracts';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Link, Slot, usePathname } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { api, auth, reasonOf, type SessionUser, workIn, workingInBusiness } from './api';
import { BusinessBrand, DomainBrand } from './components/Brand';
import { Button, ErrorLine } from './components/ui';
import { type BackOfficeConfig, configure } from './config';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 3_000,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
    },
  },
});

/** The server says what the person's roles allow here; the back office needs this one. */
const BACK_OFFICE = FrameworkCapabilities.backOffice.name;
/** And the Members screen this one. */
const READ_MEMBERS = FrameworkCapabilities.readMembers.name;
/** And the Support access screen this one. */
const CONSENTS = SupportConsentCapability.name;
type Me = Awaited<ReturnType<ApiClient['me']>>;
type PlatformMe = Awaited<ReturnType<ApiClient['platform']['me']>>;

function SignIn({ title, onSignedIn }: { title: string; onSignedIn: (u: SessionUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onSignedIn(await auth.signIn(email.trim(), password));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? 'Wrong email or password' : reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="flex-1 items-center justify-center bg-bg px-4">
      <View className="w-full max-w-sm gap-4 rounded-card border border-border bg-card p-6">
        <View className="gap-1">
          <DomainBrand
            fallback={title}
            suffix=" back office"
            className="text-title font-title text-text"
          />
          <Text className="text-body text-muted">
            Conversations the assistant handed to your team. Sign in with your app account.
          </Text>
        </View>
        <TextInput
          accessibilityLabel="Email"
          placeholder="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
          className="min-h-10 rounded-control border border-border bg-card px-3 text-body text-text"
        />
        <TextInput
          accessibilityLabel="Password"
          placeholder="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
          className="min-h-10 rounded-control border border-border bg-card px-3 text-body text-text"
        />
        <ErrorLine message={error} />
        <Button label="Sign in" tone="primary" busy={busy} onPress={submit} />
      </View>
    </View>
  );
}

function NavLink({
  href,
  label,
}: {
  href: '/' | '/templates' | '/members' | '/settings' | '/support' | '/operator';
  label: string;
}) {
  const path = usePathname();
  const active = href === '/' ? path === '/' || path.startsWith('/conversation') : path === href;
  return (
    <Link href={href} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityState={{ selected: active }}
        className={`rounded-control px-3 py-1.5 ${active ? 'bg-primary-tint' : ''}`}
      >
        <Text className={`text-small font-heading ${active ? 'text-primary' : 'text-muted'}`}>
          {label}
        </Text>
      </Pressable>
    </Link>
  );
}

/** Working in a business under support access: which one, and a way back. */
function SupportBanner({ me, onStop }: { me: Me; onStop: () => void }) {
  if (!workingInBusiness()) return null;
  return (
    <View className="flex-row items-center gap-2 border-b border-divider bg-warn-bg px-4 py-2">
      <Text className="flex-1 text-small text-warn-text">
        Support access to business {me.tenantId}
        {me.as === 'support' ? '' : ' (not active: the business has not let you in)'}. Everything
        you do here is recorded for the business.
      </Text>
      <Button label="Stop" tone="secondary" onPress={onStop} />
    </View>
  );
}

function Shell({
  title,
  user,
  me,
  operator,
  onSignOut,
  onStopSupport,
}: {
  title: string;
  user: SessionUser;
  me: Me;
  operator: PlatformMe['operator'];
  onSignOut: () => void;
  onStopSupport: () => void;
}) {
  const team = me.capabilities.includes(BACK_OFFICE);
  return (
    <View className="flex-1 bg-bg">
      <View className="flex-row items-center gap-2 border-b border-divider bg-card px-4 py-2">
        <BusinessBrand fallback={title} className="text-heading font-title text-text" />
        <Text className="mr-4 text-small text-muted">Back office</Text>
        {team ? <NavLink href="/" label="Conversations" /> : null}
        {team ? <NavLink href="/templates" label="Templates" /> : null}
        {me.capabilities.includes(READ_MEMBERS) ? (
          <NavLink href="/members" label="Members" />
        ) : null}
        {team ? <NavLink href="/settings" label="Settings" /> : null}
        {me.capabilities.includes(CONSENTS) ? <NavLink href="/support" label="Support" /> : null}
        {operator ? <NavLink href="/operator" label="Operator" /> : null}
        <View className="flex-1" />
        <Text className="hidden text-small text-muted md:flex">
          {user.name} · {me.roles.join(', ')}
        </Text>
        <Button label="Sign out" tone="quiet" onPress={onSignOut} />
      </View>
      <SupportBanner me={me} onStop={onStopSupport} />
      <Slot />
    </View>
  );
}

/** Join a business with the code from an invitation (sent to this account's email). */
function JoinWithCode({ onJoined }: { onJoined: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const join = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.members.acceptInvite(code.trim());
      queryClient.clear();
      onJoined();
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="w-full max-w-sm gap-2">
      <TextInput
        accessibilityLabel="Invitation code"
        placeholder="Invitation code"
        autoCapitalize="none"
        value={code}
        onChangeText={setCode}
        onSubmitEditing={join}
        className="min-h-10 rounded-control border border-border bg-card px-3 text-body text-text"
      />
      <ErrorLine message={error} />
      <Button label="Join" tone="primary" disabled={!code.trim()} busy={busy} onPress={join} />
    </View>
  );
}

function Gate({ title }: { title: string }) {
  const session = useQuery({ queryKey: ['session'], queryFn: auth.me });
  const user = session.data;
  const me = useQuery({ queryKey: ['me', user?.id], queryFn: api.me, enabled: !!user });
  // Whether they are one of the platform's operators (B19): operator mode, even with no business.
  const platform = useQuery({
    queryKey: ['platform', 'me', user?.id],
    queryFn: api.platform.me,
    enabled: !!user,
  });
  const operator = platform.data?.operator ?? null;
  const signOut = async () => {
    await auth.signOut().catch(() => {});
    workIn(null);
    queryClient.clear();
    await session.refetch();
  };
  const stopSupport = () => {
    workIn(null);
    queryClient.clear();
  };
  // Working in a business under support access that ended (or never began): back to one's own.
  const lost = me.isError && !!workingInBusiness();
  useEffect(() => {
    if (lost) stopSupport();
  }, [lost]);
  if (lost) return null;
  if (session.isPending || (user && (me.isPending || platform.isPending)))
    return (
      <View className="flex-1 items-center justify-center bg-bg">
        <ActivityIndicator />
      </View>
    );
  if (!user) return <SignIn title={title} onSignedIn={() => session.refetch()} />;
  if (!me.data?.capabilities.includes(BACK_OFFICE) && !operator)
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-bg px-4">
        <Text className="text-heading font-heading text-text">This is for the business's team</Text>
        <Text className="max-w-sm text-center text-body text-muted">
          {user.email} is not staff in this business. Ask the owner to add you, or enter the
          invitation code they gave you.
        </Text>
        <JoinWithCode onJoined={() => me.refetch()} />
        <Button label="Sign out" onPress={signOut} />
      </View>
    );
  if (!me.data) return null;
  return (
    <Shell
      title={title}
      user={user}
      me={me.data}
      operator={operator}
      onSignOut={signOut}
      onStopSupport={stopSupport}
    />
  );
}

export type BackOfficeShellProps = {
  /** The product's name, in the header and on sign-in, while the business has none of its own. */
  title: string;
  /** What the application read from its environment: the API's address. */
  config?: Partial<BackOfficeConfig>;
};

/**
 * The back office around its routes: staff sign-in, the role check, the header and its
 * navigation. An application's root _layout renders it; its routes re-export the screens.
 */
export function BackOfficeShell({ title, config }: BackOfficeShellProps) {
  if (config) configure(config);
  const [fontsLoaded] = useFonts({ SchibstedGrotesk_600SemiBold, SchibstedGrotesk_700Bold });
  if (!fontsLoaded) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <Gate title={title} />
    </QueryClientProvider>
  );
}
