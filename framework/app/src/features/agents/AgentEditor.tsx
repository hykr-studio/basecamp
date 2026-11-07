import type { Agent, AgentTriggerKind } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { type ReactNode, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api } from '../../api';
import { Button } from '../../components/Button';
import { ScreenTitle, SectionHeading } from '../../components/ScreenTitle';
import { useScreenContext } from '../../framework/assistant-context';
import { LoadError } from '../../framework/EmptyState';
import { Field } from '../../framework/Field';
import { errorMessage } from '../../framework/hooks';
import { Loading } from '../../framework/Loading';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { colors, space, styles } from '../../theme';
import { Pill, RunRow } from './AgentsScreen';
import {
  type AgentDraft,
  blankTrigger,
  draftOf,
  inputOf,
  newDraft,
  TRIGGER_KINDS,
  type TriggerDraft,
} from './form';

/** A choice that is on or off. */
function Chip(props: { label: string; on: boolean; onPress?: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.on, disabled: !props.onPress }}
      accessibilityLabel={props.label}
      disabled={!props.onPress}
      onPress={props.onPress}
      style={{
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderColor: props.on ? colors.primary : colors.border,
        backgroundColor: props.on ? colors.primaryTint : colors.card,
        opacity: props.onPress ? 1 : 0.6,
      }}
    >
      <Text style={{ fontSize: 13, color: props.on ? colors.primary : colors.muted }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={[styles.card, { gap: space.md }]}>
      <SectionHeading>{title}</SectionHeading>
      {children}
    </View>
  );
}

/** One trigger's fields, by its kind. */
function TriggerFields(props: {
  t: TriggerDraft;
  edit: (t: TriggerDraft) => void;
  remove: () => void;
  readOnly: boolean;
}) {
  const { t, edit, readOnly } = props;
  const set = (patch: Partial<TriggerDraft>) => edit({ ...t, ...patch });
  const kind = TRIGGER_KINDS.find((k) => k.kind === t.kind)?.label ?? t.kind;
  return (
    <View style={{ gap: space.sm, borderTopWidth: 1, borderColor: colors.divider, paddingTop: 8 }}>
      <View style={styles.row}>
        <Text style={[styles.label, { flex: 1 }]}>{kind}</Text>
        {readOnly ? null : (
          <Button title="Remove" variant="ghost" icon="x" iconOnly onPress={props.remove} />
        )}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {t.kind === 'once' ? (
          <Field
            label="When"
            hint="A date and time, e.g. 2026-11-20 09:00"
            value={t.when}
            onChangeText={(when) => set({ when })}
            editable={!readOnly}
          />
        ) : null}
        {t.kind === 'recurring' ? (
          <>
            <Field
              label="Schedule (cron)"
              hint="minute hour day month weekday: 0 9 * * 1 is Mondays at 09:00"
              value={t.when}
              onChangeText={(when) => set({ when })}
              editable={!readOnly}
            />
            <Field
              label="Time zone"
              hint="The business's when empty"
              value={t.timeZone}
              onChangeText={(timeZone) => set({ timeZone })}
              editable={!readOnly}
              width={200}
            />
          </>
        ) : null}
        {t.kind === 'event' ? (
          <>
            <Field
              label="Events"
              hint="Names or prefixes, comma-separated: task.created, meeting.*"
              value={t.list}
              onChangeText={(list) => set({ list })}
              editable={!readOnly}
            />
            <Field
              label="Only when (JSON)"
              hint='Fields of the record, e.g. {"done": false}'
              value={t.where}
              onChangeText={(where) => set({ where })}
              editable={!readOnly}
            />
          </>
        ) : null}
        {t.kind === 'condition' ? (
          <>
            <Field
              label="Record type"
              value={t.target}
              onChangeText={(target) => set({ target })}
              editable={!readOnly}
              width={180}
            />
            <Field
              label="Matches (JSON)"
              hint='Its list filters; $today and $now move: {"dueOn": {"lt": "$today"}}'
              value={t.where}
              onChangeText={(where) => set({ where })}
              editable={!readOnly}
            />
            <Field
              label="Check every (minutes)"
              value={t.everyMinutes}
              onChangeText={(everyMinutes) => set({ everyMinutes })}
              keyboardType="number-pad"
              editable={!readOnly}
              width={160}
            />
          </>
        ) : null}
        {t.kind === 'message' ? (
          <Field
            label="With one of these words"
            hint="Comma-separated; any message when empty"
            value={t.list}
            onChangeText={(list) => set({ list })}
            editable={!readOnly}
          />
        ) : null}
        {t.kind === 'webhook' ? (
          <>
            <Field
              label="Connection"
              hint="An agents connection (Integrations)"
              value={t.target}
              onChangeText={(target) => set({ target })}
              editable={!readOnly}
            />
            <Field
              label="Event types"
              value={t.list}
              onChangeText={(list) => set({ list })}
              editable={!readOnly}
              width={200}
            />
          </>
        ) : null}
        {t.kind === 'mention' ? (
          <Text style={styles.muted}>Runs when someone names it in a comment.</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Make or change an agent: what it does (its instructions), what starts it, the tools it may use
 * and its budget. Its owner changes all of it; a manager who is not the owner pauses, runs or
 * deletes it.
 */
export function AgentEditor({ params }: { params: Readonly<Record<string, string>> }) {
  const id = params.id;
  useScreenContext({ screen: 'agent.edit', ...(id ? { record: { type: 'agent', id } } : {}) });
  const { lang } = useT();
  const toast = useToast();
  const client = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 60_000 });
  const options = useQuery({
    queryKey: ['agent-templates', lang],
    queryFn: () => api.agents.templates(lang),
  });
  const existing = useQuery({
    queryKey: ['agents', id],
    queryFn: () => api.agents.get(id as string),
    enabled: !!id,
  });
  const runs = useQuery({
    queryKey: ['agent-runs', id],
    queryFn: () => api.agents.runs({ agentId: id as string, limit: 20 }),
    enabled: !!id,
  });
  const [draft, setDraft] = useState<AgentDraft | undefined>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (draft) return;
    if (id && existing.data) setDraft(draftOf(existing.data as Agent));
    if (!id && options.data) {
      const template = options.data.items.find((t) => t.key === params.template);
      setDraft(newDraft(template));
    }
  }, [draft, id, existing.data, options.data, params.template]);

  const agent = existing.data as Agent | undefined;
  const mine = !agent || agent.ownerId === me.data?.userId;
  const done = () => client.invalidateQueries({ queryKey: ['agents'] });
  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error('Nothing to save');
      const made = inputOf(draft);
      if ('error' in made) throw new Error(made.error);
      return id ? api.agents.update(id, made.input) : api.agents.create(made.input);
    },
    onSuccess: async (result) => {
      setProblem(undefined);
      await done();
      if (result.status === 'needs_approval') {
        toast.show({ message: 'Waiting for approval', tone: 'neutral' });
        return;
      }
      toast.show({ message: id ? 'Saved' : 'Agent made', tone: 'success' });
      if (!id) router.replace(`/agents/${result.value.id}` as never);
    },
    onError: (e) => setProblem(errorMessage(e)),
  });
  const status = useMutation({
    mutationFn: (next: 'active' | 'paused') => api.agents.update(id as string, { status: next }),
    onSuccess: done,
    onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
  });
  const runNow = useMutation({
    mutationFn: () => api.agents.runNow(id as string),
    onSuccess: async () => {
      toast.show({ message: 'Started: its run shows below', tone: 'success' });
      await client.invalidateQueries({ queryKey: ['agent-runs'] });
    },
    onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
  });
  const remove = useMutation({
    mutationFn: () => api.agents.remove(id as string),
    onSuccess: async () => {
      await done();
      router.replace('/agents' as never);
    },
    onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
  });

  if (existing.error) return <LoadError what="this agent" onRetry={() => existing.refetch()} />;
  if (!draft) return <Loading />;
  const set = (patch: Partial<AgentDraft>) => setDraft({ ...draft, ...patch });
  const readOnly = !mine;
  const tools = options.data?.tools ?? [];
  const add = (kind: AgentTriggerKind) =>
    set({ triggers: [...draft.triggers, blankTrigger(kind)] });

  return (
    <ScrollView contentContainerStyle={[styles.content, { gap: space.lg }]}>
      <ScreenTitle
        title={agent ? agent.name : 'New agent'}
        subtitle={
          readOnly
            ? 'Someone else’s agent: you can pause, run or delete it.'
            : 'It acts for you, with only the tools you give it.'
        }
        action={agent?.status === 'paused' ? <Pill label="Paused" tone="warn" /> : undefined}
      />
      <Section title="What it does">
        <Field
          label="Name"
          value={draft.name}
          onChangeText={(name) => set({ name })}
          editable={!readOnly}
        />
        <Field
          label="Description"
          value={draft.description}
          onChangeText={(description) => set({ description })}
          editable={!readOnly}
        />
        <Field
          label="Instructions"
          hint="In your words: what to look at, what to do, what to say."
          value={draft.instructions}
          onChangeText={(instructions) => set({ instructions })}
          multiline
          multilineHeight={120}
          editable={!readOnly}
        />
      </Section>
      <Section title="What starts it">
        {draft.triggers.length === 0 ? (
          <Text style={styles.muted}>Nothing yet: it runs only when you start it.</Text>
        ) : null}
        {draft.triggers.map((t, i) => (
          <TriggerFields
            // biome-ignore lint/suspicious/noArrayIndexKey: triggers have no id until saved
            key={i}
            t={t}
            readOnly={readOnly}
            edit={(next) => set({ triggers: draft.triggers.map((x, j) => (j === i ? next : x)) })}
            remove={() => set({ triggers: draft.triggers.filter((_, j) => j !== i) })}
          />
        ))}
        {readOnly ? null : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {TRIGGER_KINDS.map((k) => (
              <Chip key={k.kind} label={`+ ${k.label}`} on={false} onPress={() => add(k.kind)} />
            ))}
          </View>
        )}
      </Section>
      <Section title="Tools it may use">
        <Text style={styles.muted}>
          Only these, and never more than you may do yourself. Writes that need approval wait for
          you.
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {tools.map((tool) => {
            const on = draft.tools.includes(tool);
            return (
              <Chip
                key={tool}
                label={tool}
                on={on}
                onPress={
                  readOnly
                    ? undefined
                    : () =>
                        set({
                          tools: on
                            ? draft.tools.filter((x) => x !== tool)
                            : [...draft.tools, tool],
                        })
                }
              />
            );
          })}
        </View>
      </Section>
      <Section title="Budget">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {(['day', 'week', 'month'] as const).map((p) => (
            <Chip
              key={p}
              label={`Per ${p}`}
              on={draft.period === p}
              onPress={readOnly ? undefined : () => set({ period: p })}
            />
          ))}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          <Field
            label="Runs"
            value={draft.runs}
            onChangeText={(runs) => set({ runs })}
            keyboardType="number-pad"
            placeholder="No limit"
            editable={!readOnly}
            width={140}
          />
          <Field
            label="Tokens"
            value={draft.tokens}
            onChangeText={(tokens) => set({ tokens })}
            keyboardType="number-pad"
            placeholder="No limit"
            editable={!readOnly}
            width={140}
          />
          <Field
            label="Credits"
            value={draft.credits}
            onChangeText={(credits) => set({ credits })}
            keyboardType="number-pad"
            placeholder="No limit"
            editable={!readOnly}
            width={140}
          />
          <Field
            label="Steps per run"
            value={draft.maxSteps}
            onChangeText={(maxSteps) => set({ maxSteps })}
            keyboardType="number-pad"
            editable={!readOnly}
            width={140}
          />
        </View>
      </Section>
      {problem ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {problem}
        </Text>
      ) : null}
      <View style={[styles.row, { flexWrap: 'wrap' }]}>
        {readOnly ? null : (
          <Button
            title={id ? 'Save' : 'Make agent'}
            busy={save.isPending}
            onPress={() => save.mutate()}
          />
        )}
        {agent ? (
          <>
            <Button
              title="Run now"
              variant="secondary"
              icon="play"
              busy={runNow.isPending}
              disabled={agent.status !== 'active'}
              onPress={() => runNow.mutate()}
            />
            <Button
              title={agent.status === 'paused' ? 'Resume' : 'Pause'}
              variant="secondary"
              icon={agent.status === 'paused' ? 'play-circle' : 'pause'}
              busy={status.isPending}
              onPress={() => status.mutate(agent.status === 'paused' ? 'active' : 'paused')}
            />
            <Button
              title="Delete"
              variant="danger"
              icon="trash-2"
              busy={remove.isPending}
              onPress={() => remove.mutate()}
            />
          </>
        ) : null}
      </View>
      {agent ? (
        <View style={styles.section}>
          <SectionHeading>Run log</SectionHeading>
          {runs.data?.items.length ? (
            <View>
              {runs.data.items.map((r, i) => (
                <RunRow key={r.id} run={r} index={i} count={runs.data.items.length} />
              ))}
            </View>
          ) : (
            <Text style={styles.muted}>No runs yet.</Text>
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}
