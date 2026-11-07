import { useQuery } from '@tanstack/react-query';
import { ScrollView, Text, View } from 'react-native';
import { api } from '../../api';
import { ScreenTitle, SectionHeading } from '../../components/ScreenTitle';
import { useScreenContext } from '../../framework/assistant-context';
import { when } from '../../framework/dates';
import { LoadError } from '../../framework/EmptyState';
import { Loading } from '../../framework/Loading';
import { space, styles } from '../../theme';
import { Pill } from './AgentsScreen';
import { RUN_STATUS } from './form';

/** What a message said: its text parts. */
const textOf = (parts: readonly { type: string; text?: unknown }[]) =>
  parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');

/**
 * One run of an agent: what started it, how it went (and why, when it was refused or failed), the
 * tools it called, and its messages.
 */
export function AgentRunScreen({ params }: { params: Readonly<Record<string, string>> }) {
  useScreenContext({ screen: 'agent.run' });
  const run = useQuery({
    queryKey: ['agent-run', params.id],
    queryFn: () => api.agents.run(params.id),
  });
  if (run.error) return <LoadError what="this run" onRetry={() => run.refetch()} />;
  if (!run.data) return <Loading />;
  const r = run.data;
  const s = RUN_STATUS[r.status];
  return (
    <ScrollView contentContainerStyle={[styles.content, { gap: space.lg }]}>
      <ScreenTitle
        title={`Run ${when(r.createdAt)}`}
        subtitle={r.trigger.label}
        action={<Pill label={s.label} tone={s.tone} />}
      />
      {r.reason ? <Text style={styles.error}>{r.reason}</Text> : null}
      {r.toolCalls.length ? (
        <View style={styles.card}>
          <SectionHeading>What it did</SectionHeading>
          {r.toolCalls.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: calls repeat
            <Text key={i} style={styles.text}>
              {c.tool}: {c.outcome}
              {c.detail ? ` (${c.detail})` : ''}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={{ gap: space.md }}>
        {r.messages.map((m) => (
          <View key={m.id} style={styles.card}>
            <Text style={styles.label}>{m.role === 'user' ? 'Started with' : 'It said'}</Text>
            <Text style={styles.text} selectable>
              {textOf(m.parts as { type: string; text?: unknown }[])}
            </Text>
          </View>
        ))}
      </View>
      <Text style={styles.muted}>
        {r.usage.inputTokens + r.usage.outputTokens} tokens · {r.model ?? 'no model'} ·{' '}
        {r.agentVersion ?? ''}
      </Text>
    </ScrollView>
  );
}
