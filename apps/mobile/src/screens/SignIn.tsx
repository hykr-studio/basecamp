import { useState } from 'react';
import { Text, View } from 'react-native';
import { auth, type SessionUser } from '../api';
import { Button } from '../components/Button';
import { Field } from '../framework/Field';
import { errorMessage } from '../framework/hooks';
import { space, styles } from '../theme';

export function SignIn({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signingUp = mode === 'signUp';
  const short = password.length > 0 && password.length < 8;

  async function submit() {
    if (!email || password.length < 8) return;
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
    <View style={[styles.content, { maxWidth: 440, marginTop: 56 }]}>
      <View style={{ gap: space.xs }}>
        <Text style={styles.title}>Meetings</Text>
        <Text style={styles.muted}>
          The agentic stack template: an assistant acts for you through the same API, and anything
          risky waits for your approval.
        </Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{signingUp ? 'Create your account' : 'Sign in'}</Text>
        {signingUp && (
          <Field label="Name" value={name} onChangeText={setName} autoComplete="name" />
        )}
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@example.com"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete={signingUp ? 'new-password' : 'current-password'}
          hint="At least 8 characters."
          error={short ? `At least 8 characters: ${8 - password.length} more.` : null}
          onSubmitEditing={submit}
        />
        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}
        <Button
          title={signingUp ? 'Create account' : 'Sign in'}
          onPress={submit}
          busy={busy}
          disabled={!email || password.length < 8}
        />
        <Button
          variant="subtle"
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
