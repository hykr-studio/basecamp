import type { Business } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollView, View } from 'react-native';
import { api } from '../../api';
import { ScreenTitle } from '../../components/ScreenTitle';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Text } from '../../components/ui/text';
import { useScreenContext } from '../../framework/assistant-context';
import { chooseBusiness } from '../../framework/business';
import { LoadError } from '../../framework/EmptyState';
import { errorMessage } from '../../framework/hooks';
import { Loading } from '../../framework/Loading';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { styles } from '../../theme';

/** One business: how the person is there, and the way in. */
function Row({ b, current }: { b: Business; current: boolean }) {
  const { t } = useT();
  const toast = useToast();
  const client = useQueryClient();
  const makeDefault = useMutation({
    mutationFn: () => api.setDefaultBusiness(b.tenantId),
    onSuccess: () => client.invalidateQueries({ queryKey: ['me'] }),
    onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
  });
  const roles = b.as === 'participant' ? b.participantRoles : b.roles;
  return (
    <Card>
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="flex-1 gap-1">
          <Text className="font-semibold">{b.name}</Text>
          <View className="flex-row flex-wrap items-center gap-2">
            <Badge variant={b.as === 'member' ? 'info' : 'neutral'}>
              <Text>{t(b.as === 'member' ? 'businesses.member' : 'businesses.participant')}</Text>
            </Badge>
            {roles.length ? <Text variant="muted">{roles.join(', ')}</Text> : null}
          </View>
        </View>
        {current ? (
          <Badge variant="success">
            <Text>{t('businesses.current')}</Text>
          </Badge>
        ) : (
          <Button
            variant="secondary"
            accessibilityLabel={`${t('businesses.switch')}: ${b.name}`}
            // Everything under the switcher starts again in that business (businessesPlugin).
            onPress={() => chooseBusiness(b.tenantId)}
          >
            <Text>{t('businesses.switch')}</Text>
          </Button>
        )}
        {b.as === 'member' && !b.isDefault ? (
          <Button
            variant="ghost"
            disabled={makeDefault.isPending}
            onPress={() => makeDefault.mutate()}
            accessibilityLabel={`${t('businesses.makeDefault')}: ${b.name}`}
          >
            <Text>{t('businesses.makeDefault')}</Text>
          </Button>
        ) : null}
      </View>
    </Card>
  );
}

/**
 * Every business the person is in, as a member of its team or as a participant on its records,
 * and the one they are working in. Choosing another sends it as `x-tenant-id` from then on.
 */
export function BusinessesScreen() {
  useScreenContext({ screen: 'businesses' });
  const { t } = useT();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me() });
  const data = me.data;
  return (
    <ScrollView contentContainerStyle={[styles.content, { gap: 16 }]}>
      <ScreenTitle title={t('businesses.title')} subtitle={t('businesses.subtitle')} />
      {me.error ? (
        <LoadError what="your businesses" onRetry={() => me.refetch()} />
      ) : !data ? (
        <Loading />
      ) : data.businesses.length ? (
        data.businesses.map((b) => (
          <Row key={b.tenantId} b={b} current={b.tenantId === data.tenantId} />
        ))
      ) : (
        <Text variant="muted">{t('businesses.none')}</Text>
      )}
    </ScrollView>
  );
}
