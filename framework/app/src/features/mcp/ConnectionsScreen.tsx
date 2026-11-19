import type { McpConnection } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollView, View } from 'react-native';
import { api } from '../../api';
import { ScreenTitle } from '../../components/ScreenTitle';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Text } from '../../components/ui/text';
import { useScreenContext } from '../../framework/assistant-context';
import { when } from '../../framework/dates';
import { LoadError } from '../../framework/EmptyState';
import { errorMessage } from '../../framework/hooks';
import { Loading } from '../../framework/Loading';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { styles } from '../../theme';
import { scopeWords } from './scopes';

const KEY = ['mcp', 'connections'];

function Connection({ c }: { c: McpConnection }) {
  const { t } = useT();
  const toast = useToast();
  const client = useQueryClient();
  const disconnect = useMutation({
    mutationFn: () => api.mcp.disconnect(c.clientId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: KEY });
      toast.show({ message: t('mcp.connections.disconnected', { name: c.name }), tone: 'success' });
    },
    onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
  });
  return (
    <Card>
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text className="font-semibold">{c.name}</Text>
          {c.connectedAt && (
            <Text variant="muted">{t('mcp.connections.since', { date: when(c.connectedAt) })}</Text>
          )}
          <Text variant="muted">{scopeWords(c.scopes, t).join(' · ')}</Text>
        </View>
        <Button
          variant="secondary"
          size="sm"
          disabled={disconnect.isPending}
          onPress={() => disconnect.mutate()}
          accessibilityLabel={`${t('mcp.connections.disconnect')} ${c.name}`}
        >
          <Text>{t('mcp.connections.disconnect')}</Text>
        </Button>
      </View>
    </Card>
  );
}

/**
 * The outside AI clients (MCP) the person connected in this business, and disconnecting one:
 * its tokens stop at once. Each person sees only their own; the API decides.
 */
export function ConnectionsScreen() {
  useScreenContext({ screen: 'connections' });
  const { t } = useT();
  const list = useQuery({ queryKey: KEY, queryFn: () => api.mcp.connections() });
  const items = list.data?.items;
  return (
    <ScrollView contentContainerStyle={[styles.content, { gap: 16 }]}>
      <ScreenTitle title={t('mcp.connections.title')} subtitle={t('mcp.connections.lead')} />
      {list.error ? (
        <LoadError what="the connected apps" onRetry={() => list.refetch()} />
      ) : !items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Text variant="muted">{t('mcp.connections.empty')}</Text>
      ) : (
        items.map((c) => <Connection key={c.clientId} c={c} />)
      )}
    </ScrollView>
  );
}
