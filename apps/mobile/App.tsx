import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { auth, type SessionUser } from './src/api';
import { SignIn } from './src/screens/SignIn';
import { Todos } from './src/screens/Todos';
import { colors, styles } from './src/theme';

export default function App() {
  // undefined while the session loads, null when signed out.
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  useEffect(() => {
    auth
      .me()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      {user === undefined ? (
        <ActivityIndicator style={{ marginTop: 96 }} color={colors.primary} />
      ) : user === null ? (
        <SignIn onSignedIn={setUser} />
      ) : (
        <Todos
          user={user}
          onSignOut={() => {
            auth.signOut().finally(() => setUser(null));
          }}
        />
      )}
    </View>
  );
}
