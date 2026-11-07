import type { Agent, AgentRun } from '@hykr/contracts';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api } from '../../api';
import { Button } from '../../components/Button';
import { ScreenTitle, SectionHeading } from '../../components/ScreenTitle';
import { useScreenContext } from '../../framework/assistant-context';
import { when } from '../../framework/dates';
import { EmptyState, LoadError } from '../../framework/EmptyState';
import { Icon } from '../../framework/Icon';
import { Loading } from '../../framework/Loading';
import { useT } from '../../framework/lang';
import { inApp } from '../../framework/web-link';
import { colors, listRow, space, styles } from '../../theme';
import { RUN_STATUS, triggerWords } from './form';

/** A small status pill. */
export function Pill({ label, tone }: { label: string; tone: keyof typeof TONES }) {
  const [bg, fg] = TONES[tone];
  return (
    <View
      style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 }}
    >
      <Text style={{ color: fg, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

const TONES = {
  neutral: [colors.divider, colors.muted],
  info: [colors.primaryTint, colors.primary],
  success: [colors.successTint, colors.success],
  warn: [colors.warnBg, colors.warnText],
  danger: [colors.dangerTint, colors.danger],
} as const;

/** One run in a list: when, what started it, how it went. */
export function RunRow({ run, index, count }: { run: AgentRun; index: number; count: number }) {
  const s = RUN_STATUS[run.status];
  return (
    <View style={listRow(index, count)}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Run ${when(run.createdAt)}: ${s.label}`}
        onPress={inApp(() => router.navigate(`/agents/runs/${run.id}` as never))}
        style={{ gap: 2, paddingVertical: space.sm }}
      >
        <View style={styles.row}>
          <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>
            {run.reply?.split('\n')[0] || run.reason || run.trigger.label}
          </Text>
          <Pill label={s.label} tone={s.tone} />
        </View>
        <Text style={styles.muted}>
          {when(run.createdAt)} · {run.trigger.label}
        </Text>
      </Pressable>
    </View>
  );
}

function AgentRow({ agent, index, count }: { agent: Agent; index: number; count: number }) {
  return (
    <View style={listRow(index, count)}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={agent.name}
        onPress={inApp(() => router.navigate(`/agents/${agent.id}` as never))}
        style={{ flexDirection: 'row', gap: space.sm, paddingVertical: space.sm }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <View style={styles.row}>
            <Text style={[styles.text, { fontWeight: '600' }]}>{agent.name}</Text>
            {agent.status === 'paused' ? <Pill label="Paused" tone="warn" /> : null}
          </View>
          <Text style={styles.muted} numberOfLines={2}>
            {agent.triggers.length
              ? agent.triggers.map(triggerWords).join(' · ')
              : 'Runs when you start it'}
          </Text>
        </View>
        <Icon name="chevron-right" size={18} color={colors.muted} />
      </Pressable>
    </View>
  );
}

/**
 * The business's agents: yours (and everyone's, for a manager), ready-made ones the application
 * offers, and the latest runs. An agent acts for its owner, with only the tools you give it.
 */
export function AgentsScreen() {
  useScreenContext({ screen: 'agents' });
  const { lang } = useT();
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.agents.list({}) });
  const templates = useQuery({
    queryKey: ['agent-templates', lang],
    queryFn: () => api.agents.templates(lang),
  });
  const runs = useQuery({
    queryKey: ['agent-runs', 'recent'],
    queryFn: () => api.agents.runs({ limit: 10 }),
  });
  const items = agents.data?.items ?? [];
  const offered = (templates.data?.items ?? []).filter((t) => t.available);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ScreenTitle
        title="Agents"
        subtitle="Helpers that do a job on their own, acting for you, with only the tools you give them."
        action={
          <Button
            title="New agent"
            icon="plus"
            onPress={() => router.navigate('/agents/new' as never)}
          />
        }
      />
      {agents.error ? (
        <LoadError what="your agents" onRetry={() => void agents.refetch()} />
      ) : agents.isLoading ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState
          icon="zap"
          title="No agents yet"
          body='Start from one below, make one, or tell the assistant: "create an agent to …".'
        />
      ) : (
        <View>
          {items.map((a, i) => (
            <AgentRow key={a.id} agent={a} index={i} count={items.length} />
          ))}
        </View>
      )}
      {offered.length ? (
        <View style={styles.section}>
          <SectionHeading>Ready-made</SectionHeading>
          {offered.map((t, i) => (
            <View key={t.key} style={listRow(i, offered.length)}>
              <View style={[styles.row, { paddingVertical: space.sm }]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.text, { fontWeight: '600' }]}>{t.name}</Text>
                  <Text style={styles.muted}>{t.description}</Text>
                </View>
                <Button
                  title="Use"
                  variant="secondary"
                  accessibilityLabel={`Use ${t.name}`}
                  onPress={() =>
                    router.navigate(`/agents/new/${encodeURIComponent(t.key)}` as never)
                  }
                />
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {runs.data?.items.length ? (
        <View style={styles.section}>
          <SectionHeading>Latest runs</SectionHeading>
          <View>
            {runs.data.items.map((r, i) => (
              <RunRow key={r.id} run={r} index={i} count={runs.data.items.length} />
            ))}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}
