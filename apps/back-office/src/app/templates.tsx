import { useQuery } from '@tanstack/react-query';
import { ScrollView, Text, View } from 'react-native';
import { api, reasonOf } from '../api';
import { Badge, Empty } from '../components/ui';

const TONE = { APPROVED: 'success', PENDING: 'warn', REJECTED: 'danger', PAUSED: 'warn' } as const;

/** What Meta has said about each template, per language. `pnpm templates:sync` sends them. */
export default function Templates() {
  const q = useQuery({ queryKey: ['templates'], queryFn: api.backoffice.templates });
  if (q.isPending) return <Empty title="Loading…" />;
  if (q.isError) return <Empty title="Can't load templates">{reasonOf(q.error)}</Empty>;
  if (q.data.length === 0)
    return <Empty title="No templates yet">Run pnpm templates:sync to send them for review.</Empty>;
  return (
    <ScrollView contentContainerClassName="p-4">
      <View className="w-full max-w-3xl self-center overflow-hidden rounded-card border border-border bg-card">
        {q.data.map((t) => (
          <View
            key={`${t.name}/${t.language}`}
            className="flex-row items-center gap-3 border-b border-divider px-4 py-3"
          >
            <View className="flex-1 gap-0.5">
              <Text className="text-body font-heading text-text">{t.name}</Text>
              <Text className="text-small text-muted">
                {t.language} · {t.category}
                {t.rejectedReason ? ` · ${t.rejectedReason}` : ''}
              </Text>
            </View>
            <Badge
              label={t.status.toLowerCase()}
              tone={TONE[t.status as keyof typeof TONE] ?? 'neutral'}
            />
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
