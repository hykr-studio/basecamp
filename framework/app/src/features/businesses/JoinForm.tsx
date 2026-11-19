import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { api } from '../../api';
import { ScreenTitle } from '../../components/ScreenTitle';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Text } from '../../components/ui/text';
import { useScreenContext } from '../../framework/assistant-context';
import { chooseBusiness } from '../../framework/business';
import { Field } from '../../framework/Field';
import { errorMessage } from '../../framework/hooks';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { styles } from '../../theme';
import { acceptInvitation, invitationToken } from './join';

/**
 * Join a business with the invitation link or code the person was sent: a party's (they become
 * a participant there) or the team's (a member). Then they work in that business.
 */
export function JoinForm({
  initial = '',
  onJoined,
}: {
  initial?: string;
  /** Before the switch to the joined business (which starts the screens again). */
  onJoined?: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const client = useQueryClient();
  const [code, setCode] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const join = useMutation({
    mutationFn: (token: string) => acceptInvitation(api, token),
    onSuccess: async (joined) => {
      setCode('');
      toast.show({ message: t('businesses.join.done'), tone: 'success' });
      onJoined?.();
      await client.invalidateQueries({ queryKey: ['me'] });
      // Everything under the switcher starts again in that business (businessesPlugin).
      chooseBusiness(joined.tenantId);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    const token = invitationToken(code);
    if (!token) {
      setError(t('businesses.join.empty'));
      return;
    }
    setError(null);
    join.mutate(token);
  };
  return (
    <Card>
      <Text variant="heading">{t('businesses.join.title')}</Text>
      <Text variant="muted">{t('businesses.join.body')}</Text>
      <View className="flex-row flex-wrap items-end gap-2">
        <Field
          label={t('businesses.join.label')}
          value={code}
          onChangeText={setCode}
          onSubmitEditing={submit}
          autoCapitalize="none"
          autoCorrect={false}
          error={error}
        />
        <Button disabled={join.isPending} onPress={submit}>
          <Text>{t('businesses.join.submit')}</Text>
        </Button>
      </View>
    </Card>
  );
}

/**
 * An invitation link opened in the app (`/businesses/join?token=…`): the code is filled in, and
 * the person joins with one press, signed in with the email it was sent to.
 */
export function JoinScreen() {
  useScreenContext({ screen: 'businesses.join' });
  const { t } = useT();
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  const initial = (Array.isArray(token) ? token[0] : token) ?? '';
  return (
    <ScrollView contentContainerStyle={[styles.content, { gap: 16 }]}>
      <ScreenTitle title={t('businesses.title')} subtitle={t('businesses.subtitle')} />
      <JoinForm initial={initial} onJoined={() => router.replace('/businesses' as never)} />
    </ScrollView>
  );
}
