import {
  SchibstedGrotesk_600SemiBold,
  SchibstedGrotesk_700Bold,
  useFonts,
} from '@expo-google-fonts/schibsted-grotesk';
import { type ApiClient, ApiError } from '@hykr/api-client';
import { FrameworkCapabilities } from '@hykr/contracts';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Link, Slot, usePathname } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { api, auth, reasonOf, type SessionUser } from './api';
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
type Me = Awaited<ReturnType<ApiClient['me']>>;

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
  href: '/' | '/templates' | '/members' | '/settings';
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

function Shell({
  title,
  user,
  me,
  onSignOut,
}: {
  title: string;
  user: SessionUser;
  me: Me;
  onSignOut: () => void;
}) {
  return (
    <View className="flex-1 bg-bg">
      <View className="flex-row items-center gap-2 border-b border-divider bg-card px-4 py-2">
        <BusinessBrand fallback={title} className="text-heading font-title text-text" />
        <Text className="mr-4 text-small text-muted">Back office</Text>
        <NavLink href="/" label="Conversations" />
        <NavLink href="/templates" label="Templates" />
        {me.capabilities.includes(READ_MEMBERS) ? (
          <NavLink href="/members" label="Members" />
        ) : null}
        <NavLink href="/settings" label="Settings" />
        <View className="flex-1" />
        <Text className="hidden text-small text-muted md:flex">
          {user.name} · {me.roles.join(', ')}
        </Text>
        <Button label="Sign out" tone="quiet" onPress={onSignOut} />
      </View>
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
  const signOut = async () => {
    await auth.signOut().catch(() => {});
    queryClient.clear();
    await session.refetch();
  };
  if (session.isPending || (user && me.isPending))
    return (
      <View className="flex-1 items-center justify-center bg-bg">
        <ActivityIndicator />
      </View>
    );
  if (!user) return <SignIn title={title} onSignedIn={() => session.refetch()} />;
  if (!me.data?.capabilities.includes(BACK_OFFICE))
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
  return <Shell title={title} user={user} me={me.data} onSignOut={signOut} />;
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
