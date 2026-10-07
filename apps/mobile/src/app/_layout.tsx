import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { auth, type SessionUser } from '../api';
import { Button } from '../components/Button';
import { Chat } from '../components/Chat';
import { ApprovalCard } from '../framework/ApprovalCard';
import { AssistantProvider } from '../framework/assistant-context';
import { SignIn } from '../screens/SignIn';
import { colors, styles } from '../theme';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

/** Signed in: the screens, approvals on top, and the assistant beside them (below on phones). */
function Shell({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const wide = useWindowDimensions().width >= 900;
  const [chatOpen, setChatOpen] = useState(false);
  return (
    <View style={[styles.screen, { flexDirection: wide ? 'row' : 'column' }]}>
      <View style={{ flex: 1 }}>
        <View
          style={[
            styles.row,
            { justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12 },
          ]}
        >
          <Text style={styles.title}>Hi, {user.name}</Text>
          <Button title="Sign out" variant="ghost" onPress={onSignOut} />
        </View>
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <ApprovalCard />
        </View>
        <Stack
          screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}
        />
      </View>
      {wide ? (
        <View style={{ width: 400, padding: 16 }}>
          <Chat />
        </View>
      ) : (
        <View
          style={{ borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
        >
          <Pressable
            accessibilityRole="button"
            onPress={() => setChatOpen(!chatOpen)}
            style={{ padding: 12 }}
          >
            <Text style={styles.heading}>{chatOpen ? 'Hide assistant ▾' : 'Assistant ▴'}</Text>
          </Pressable>
          {/* Kept mounted so the conversation survives closing the panel. */}
          <View style={{ display: chatOpen ? 'flex' : 'none', padding: 8 }}>
            <Chat compact />
          </View>
        </View>
      )}
    </View>
  );
}

export default function RootLayout() {
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
      <AssistantProvider>
        <StatusBar style="dark" />
        {user === undefined ? (
          <ActivityIndicator style={{ marginTop: 96 }} color={colors.primary} />
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
    </QueryClientProvider>
  );
}
