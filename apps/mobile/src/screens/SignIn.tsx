import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { auth, errorMessage, type SessionUser } from '../api';
import { Button } from '../components/Button';
import { colors, styles } from '../theme';

export function SignIn({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signingUp = mode === 'signUp';

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const user = signingUp
        ? await auth.signUp(name.trim() || email, email.trim(), password)
        : await auth.signIn(email.trim(), password);
      onSignedIn(user);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.content, { maxWidth: 420, marginTop: 64 }]}>
      <View style={styles.card}>
        <Text style={styles.title}>{signingUp ? 'Create your account' : 'Sign in'}</Text>
        {signingUp && (
          <TextInput
            placeholderTextColor={colors.muted}
            style={styles.input}
            placeholder="Name"
            value={name}
            onChangeText={setName}
            autoComplete="name"
          />
        )}
        <TextInput
          placeholderTextColor={colors.muted}
          style={styles.input}
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
        />
        <TextInput
          placeholderTextColor={colors.muted}
          style={styles.input}
          placeholder="Password (8+ characters)"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete={signingUp ? 'new-password' : 'current-password'}
          onSubmitEditing={submit}
        />
        {error && <Text style={styles.error}>{error}</Text>}
        <Button
          title={signingUp ? 'Create account' : 'Sign in'}
          onPress={submit}
          busy={busy}
          disabled={!email || password.length < 8}
        />
        <Button
          variant="ghost"
          title={signingUp ? 'I already have an account' : 'Create an account instead'}
          onPress={() => {
            setMode(signingUp ? 'signIn' : 'signUp');
            setError(null);
          }}
        />
      </View>
    </View>
  );
}
