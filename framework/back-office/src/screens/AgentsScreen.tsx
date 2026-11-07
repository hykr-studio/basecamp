import { type ApiClient, ApiError } from '@hykr/api-client';
import type {
  Agent,
  AgentRun,
  AgentRunStatus,
  AgentTemplateInfo,
  CreateAgentInput,
  Member,
} from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { api, reasonOf } from '../api';
import { Badge, Button, Empty, ErrorLine } from '../components/ui';

/** When, in the reader's locale. */
const when = (iso: string) => new Date(iso).toLocaleString();

type Me = Awaited<ReturnType<ApiClient['me']>>;

const STATUS: Record<
  AgentRunStatus,
  { label: string; tone: 'neutral' | 'warn' | 'danger' | 'success' | 'primary' }
> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'primary' },
  waiting: { label: 'Waiting for approval', tone: 'warn' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  refused: { label: 'Refused', tone: 'danger' },
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-heading font-heading text-text">{title}</Text>
      <View className="gap-2 rounded-card border border-border bg-card p-4">{children}</View>
    </View>
  );
}

function Input(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  editable?: boolean;
  hint?: string;
}) {
  return (
    <View className="gap-1">
      <Text className="text-small font-heading text-text">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        multiline={props.multiline}
        editable={props.editable ?? true}
        autoCapitalize="none"
        className={`rounded-control border border-border bg-card px-3 py-2 text-body text-text ${props.multiline ? 'min-h-24' : 'min-h-9'}`}
      />
      {props.hint ? <Text className="text-small text-muted">{props.hint}</Text> : null}
    </View>
  );
}

/** The editor's fields: plain text, and the triggers and budget as JSON (power users' desk). */
type Form = {
  name: string;
  description: string;
  instructions: string;
  triggers: string;
  tools: string;
  budget: string;
  template: string | null;
};

const formOf = (a?: Agent | AgentTemplateInfo, template?: string): Form => ({
  name: a?.name ?? '',
  description: a?.description ?? '',
  instructions: a?.instructions ?? '',
  triggers: JSON.stringify(a?.triggers ?? [], null, 2),
  tools: (a?.scope.tools ?? []).join(', '),
  budget: JSON.stringify(a?.budget ?? { period: 'month', maxSteps: 6 }, null, 2),
  template: template ?? null,
});

function inputOf(f: Form): CreateAgentInput {
  const json = (s: string, what: string) => {
    try {
      return JSON.parse(s);
    } catch {
      throw new Error(`${what} is not JSON`);
    }
  };
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    instructions: f.instructions.trim(),
    triggers: json(f.triggers, 'Triggers'),
    scope: {
      tools: f.tools
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    },
    budget: json(f.budget, 'Budget'),
    ...(f.template ? { template: f.template } : {}),
  };
}

/** What a refused save said: every problem the server listed. */
function problemsOf(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { problems?: string[] } | null;
    if (body?.problems?.length) return body.problems.join('\n');
  }
  return reasonOf(e);
}

function Runs({ agentId }: { agentId: string }) {
  const runs = useQuery({
    queryKey: ['agent-runs', agentId],
    queryFn: () => api.agents.runs({ agentId, limit: 30 }),
    refetchInterval: 5000,
  });
  const [open, setOpen] = useState<string>();
  const detail = useQuery({
    queryKey: ['agent-run', open],
    queryFn: () => api.agents.run(open as string),
    enabled: !!open,
  });
  const items: AgentRun[] = runs.data?.items ?? [];
  if (!items.length) return <Text className="text-body text-muted">No runs yet.</Text>;
  return (
    <View className="gap-1">
      {items.map((r) => (
        <View key={r.id} className="gap-1 border-b border-divider py-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Run ${when(r.createdAt)}`}
            onPress={() => setOpen(open === r.id ? undefined : r.id)}
            className="flex-row items-center gap-2"
          >
            <Text className="w-40 text-small text-muted">{when(r.createdAt)}</Text>
            <Badge label={STATUS[r.status].label} tone={STATUS[r.status].tone} />
            <Text className="flex-1 text-body text-text" numberOfLines={1}>
              {r.reply?.split('\n')[0] || r.reason || r.trigger.label}
            </Text>
            <Text className="text-small text-muted">{r.trigger.label}</Text>
          </Pressable>
          {open === r.id && detail.data ? (
            <View className="gap-2 rounded-control bg-bg p-3">
              {detail.data.reason ? (
                <Text className="text-small text-danger">{detail.data.reason}</Text>
              ) : null}
              {detail.data.toolCalls.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: calls repeat
                <Text key={i} className="text-small text-text">
                  {c.tool}: {c.outcome}
                  {c.detail ? ` (${c.detail})` : ''}
                </Text>
              ))}
              {detail.data.messages.map((m) => (
                <View key={m.id} className="gap-0.5">
                  <Text className="text-small font-heading text-muted">
                    {m.role === 'user' ? 'Started with' : 'It said'}
                  </Text>
                  <Text selectable className="text-small text-text">
                    {m.parts
                      .filter((p) => p.type === 'text')
                      .map((p) => String((p as { text?: unknown }).text ?? ''))
                      .join('\n')}
                  </Text>
                </View>
              ))}
              <Text className="text-small text-muted">
                {detail.data.usage.inputTokens + detail.data.usage.outputTokens} tokens ·{' '}
                {detail.data.agentVersion ?? ''}
              </Text>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Editor(props: {
  agent?: Agent;
  template?: AgentTemplateInfo;
  mine: boolean;
  tools: string[];
  onDone: (id?: string) => void;
}) {
  const { agent, mine } = props;
  const client = useQueryClient();
  const [form, setForm] = useState<Form>(() =>
    formOf(agent ?? props.template, props.template?.key),
  );
  const [error, setError] = useState<string>();
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const refresh = () => client.invalidateQueries({ queryKey: ['agents'] });
  const save = useMutation({
    mutationFn: async () => {
      const input = inputOf(form);
      return agent ? api.agents.update(agent.id, input) : api.agents.create(input);
    },
    onSuccess: async (r) => {
      setError(undefined);
      await refresh();
      props.onDone(r.status === 'done' ? r.value.id : agent?.id);
    },
    onError: (e) => setError(problemsOf(e)),
  });
  const status = useMutation({
    mutationFn: (s: 'active' | 'paused') => api.agents.update(agent?.id as string, { status: s }),
    onSuccess: refresh,
    onError: (e) => setError(reasonOf(e)),
  });
  const runNow = useMutation({
    mutationFn: () => api.agents.runNow(agent?.id as string),
    onSuccess: () => client.invalidateQueries({ queryKey: ['agent-runs'] }),
    onError: (e) => setError(reasonOf(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.agents.remove(agent?.id as string),
    onSuccess: async () => {
      await refresh();
      props.onDone(undefined);
    },
    onError: (e) => setError(reasonOf(e)),
  });
  return (
    <View className="gap-4">
      <Section title={agent ? agent.name : props.template ? props.template.name : 'New agent'}>
        {!mine ? (
          <Text className="text-small text-muted">
            Someone else's agent: you can pause, run or delete it, not change what it does.
          </Text>
        ) : null}
        <Input label="Name" value={form.name} onChange={(name) => set({ name })} editable={mine} />
        <Input
          label="Description"
          value={form.description}
          onChange={(description) => set({ description })}
          editable={mine}
        />
        <Input
          label="Instructions"
          value={form.instructions}
          onChange={(instructions) => set({ instructions })}
          multiline
          editable={mine}
        />
        <Input
          label="Triggers (JSON)"
          value={form.triggers}
          onChange={(triggers) => set({ triggers })}
          multiline
          editable={mine}
          hint='e.g. [{"kind":"recurring","cron":"0 9 * * 1"}, {"kind":"event","on":["task.created"]}]'
        />
        <Input
          label="Tools (comma-separated)"
          value={form.tools}
          onChange={(tools) => set({ tools })}
          editable={mine}
          hint={`It may use only these: ${props.tools.join(', ')}`}
        />
        <Input
          label="Budget (JSON)"
          value={form.budget}
          onChange={(budget) => set({ budget })}
          multiline
          editable={mine}
          hint='{"period":"month","runs":100,"tokens":200000,"credits":5000,"maxSteps":6}'
        />
        <ErrorLine message={error} />
        <View className="flex-row flex-wrap gap-2">
          {mine ? (
            <Button
              label={agent ? 'Save' : 'Make agent'}
              tone="primary"
              busy={save.isPending}
              onPress={() => save.mutate()}
            />
          ) : null}
          {agent ? (
            <>
              <Button
                label="Run now"
                disabled={agent.status !== 'active'}
                busy={runNow.isPending}
                onPress={() => runNow.mutate()}
              />
              <Button
                label={agent.status === 'paused' ? 'Resume' : 'Pause'}
                busy={status.isPending}
                onPress={() => status.mutate(agent.status === 'paused' ? 'active' : 'paused')}
              />
              <Button
                label="Delete"
                tone="danger"
                busy={remove.isPending}
                onPress={() => remove.mutate()}
              />
            </>
          ) : null}
        </View>
      </Section>
      {agent ? (
        <Section title="Run log">
          <Runs agentId={agent.id} />
        </Section>
      ) : null}
    </View>
  );
}

/**
 * The business's agents at a desk: the list (every agent for a manager, one's own otherwise),
 * one agent's definition and run log beside it, and ready-made ones to start from.
 */
export function AgentsScreen() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me() });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.agents.list({}) });
  const options = useQuery({
    queryKey: ['agent-templates'],
    queryFn: () => api.agents.templates(),
  });
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.members.list(),
    enabled: !!me.data?.capabilities.includes('members.read'),
  });
  const [picked, setPicked] = useState<{ id?: string; template?: string; blank?: boolean }>({});
  const m: Me | undefined = me.data;
  const items = (agents.data?.items ?? []) as Agent[];
  const names = new Map((members.data ?? []).map((x: Member) => [x.userId, x.name]));
  const agent = items.find((a) => a.id === picked.id);
  const template = options.data?.items.find((t) => t.key === picked.template);
  const can = m?.capabilities.includes('agents.create');
  return (
    <ScrollView contentContainerClassName="gap-4 p-4">
      <View className="w-full max-w-6xl flex-row flex-wrap gap-4 self-center">
        <View className="w-full gap-3 md:w-80">
          <View className="flex-row items-center justify-between">
            <Text className="text-title font-title text-text">Agents</Text>
            {can ? (
              <Button label="New" tone="primary" onPress={() => setPicked({ blank: true })} />
            ) : null}
          </View>
          <ErrorLine message={agents.error ? reasonOf(agents.error) : undefined} />
          {items.length === 0 && !agents.isPending ? (
            <Empty title="No agents yet">Make one, or start from a ready-made one.</Empty>
          ) : null}
          {items.map((a) => (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              accessibilityState={{ selected: a.id === picked.id }}
              onPress={() => setPicked({ id: a.id })}
              className={`gap-1 rounded-card border p-3 ${a.id === picked.id ? 'border-primary bg-primary-tint' : 'border-border bg-card'}`}
            >
              <View className="flex-row items-center gap-2">
                <Text className="flex-1 text-body font-heading text-text">{a.name}</Text>
                {a.status === 'paused' ? <Badge label="Paused" tone="warn" /> : null}
              </View>
              <Text className="text-small text-muted">
                {a.ownerId === m?.userId ? 'Yours' : (names.get(a.ownerId) ?? 'Someone else’s')} ·{' '}
                {a.triggers.length ? a.triggers.map((t) => t.kind).join(', ') : 'run by hand'}
              </Text>
            </Pressable>
          ))}
          {can && options.data?.items.some((t) => t.available) ? (
            <View className="gap-2">
              <Text className="text-heading font-heading text-text">Ready-made</Text>
              {options.data.items
                .filter((t) => t.available)
                .map((t) => (
                  <Pressable
                    key={t.key}
                    accessibilityRole="button"
                    onPress={() => setPicked({ template: t.key })}
                    className="gap-0.5 rounded-card border border-border bg-card p-3"
                  >
                    <Text className="text-body font-heading text-text">{t.name}</Text>
                    <Text className="text-small text-muted">{t.description}</Text>
                  </Pressable>
                ))}
            </View>
          ) : null}
        </View>
        <View className="min-w-0 flex-1">
          {agent || template || picked.blank ? (
            <Editor
              key={`${picked.id ?? ''}${picked.template ?? ''}${picked.blank ? 'new' : ''}`}
              agent={agent}
              template={template}
              mine={!agent || agent.ownerId === m?.userId}
              tools={options.data?.tools ?? []}
              onDone={(id) => setPicked(id ? { id } : {})}
            />
          ) : (
            <Empty title="Pick an agent">Its definition and run log show here.</Empty>
          )}
        </View>
      </View>
    </ScrollView>
  );
}
