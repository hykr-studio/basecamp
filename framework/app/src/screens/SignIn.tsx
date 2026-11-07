import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Image, Platform, Text, View } from 'react-native';
import { api, auth, type SessionUser } from '../api';
import { Button } from '../components/Button';
import { Field } from '../framework/Field';
import { errorMessage } from '../framework/hooks';
import { getApp } from '../runtime';
import { space, styles } from '../theme';

/** The page's own address on the web, when it could be a business's (https); nothing elsewhere. */
const pageOrigin = () => {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const { origin } = window.location;
  return origin.startsWith('https://') ? origin : null;
};

/**
 * Before signing in: on a business's verified address (A11), its name and logo; anywhere else
 * (the product's own address, a refused request) the product's name.
 */
function DomainBrand() {
  const origin = pageOrigin();
  const brand = useQuery({
    queryKey: ['branding', 'public', origin],
    queryFn: () => api.settings.publicBranding(origin ?? undefined),
    enabled: origin !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      {brand.data?.logoUrl ? (
        <Image
          source={{ uri: brand.data.logoUrl }}
          accessibilityIgnoresInvertColors
          style={{ width: 36, height: 36, borderRadius: 8 }}
        />
      ) : null}
      <Text style={styles.title}>{brand.data?.name ?? getApp().title}</Text>
    </View>
  );
}

export function SignIn({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signingUp = mode === 'signUp';
  // The length rule is a sign-up rule; signing in only needs something in both fields.
  const short = signingUp && password.length > 0 && password.length < 8;

  async function submit() {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    if (signingUp && password.length < 8) {
      setError(`Choose a password of at least 8 characters: ${8 - password.length} more.`);
      return;
    }
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
        <DomainBrand />
        <Text style={styles.muted}>
          The agentic development stack: an assistant acts for you through the same API, and
          anything risky waits for your approval.
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
          placeholder="e.g. you@example.com"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete={signingUp ? 'new-password' : 'current-password'}
          hint={signingUp ? 'At least 8 characters.' : undefined}
          error={short ? `At least 8 characters: ${8 - password.length} more.` : null}
          onSubmitEditing={submit}
        />
        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}
        <Button title={signingUp ? 'Create account' : 'Sign in'} onPress={submit} busy={busy} />
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
