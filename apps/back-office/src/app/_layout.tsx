import '../../global.css';
import { type ApiClient, ApiError } from '@app/api-client';
import {
  SchibstedGrotesk_600SemiBold,
  SchibstedGrotesk_700Bold,
  useFonts,
} from '@expo-google-fonts/schibsted-grotesk';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Link, Slot, usePathname } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { api, auth, reasonOf, type SessionUser } from '../api';
import { Button, ErrorLine } from '../components/ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 3_000,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
    },
  },
});

const STAFF = ['owner', 'admin', 'ops', 'staff'];
type Me = Awaited<ReturnType<ApiClient['me']>>;

function SignIn({ onSignedIn }: { onSignedIn: (u: SessionUser) => void }) {
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
          <Text className="text-title font-title text-text">Basecamp back office</Text>
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

function NavLink({ href, label }: { href: '/' | '/templates'; label: string }) {
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

function Shell({ user, me, onSignOut }: { user: SessionUser; me: Me; onSignOut: () => void }) {
  return (
    <View className="flex-1 bg-bg">
      <View className="flex-row items-center gap-2 border-b border-divider bg-card px-4 py-2">
        <Text className="text-heading font-title text-text">Basecamp</Text>
        <Text className="mr-4 text-small text-muted">Back office</Text>
        <NavLink href="/" label="Conversations" />
        <NavLink href="/templates" label="Templates" />
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

function Gate() {
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
  if (!user) return <SignIn onSignedIn={() => session.refetch()} />;
  if (!me.data?.roles.some((r) => STAFF.includes(r)))
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-bg px-4">
        <Text className="text-heading font-heading text-text">This is for the business's team</Text>
        <Text className="max-w-sm text-center text-body text-muted">
          {user.email} is not staff in this business. Ask the owner to add you.
        </Text>
        <Button label="Sign out" onPress={signOut} />
      </View>
    );
  return <Shell user={user} me={me.data} onSignOut={signOut} />;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ SchibstedGrotesk_600SemiBold, SchibstedGrotesk_700Bold });
  if (!fontsLoaded) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <Gate />
    </QueryClientProvider>
  );
}
