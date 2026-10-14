import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { api, reasonOf } from '../api';
import { time, windowOf } from '../time';
import { REASONS } from './Inbox';
import { Badge, Button, Empty, ErrorLine } from './ui';

/**
 * One handed-over conversation: what the customer said, the team's replies, and the
 * composer. Inside their 24 hours a reply goes as text; after, as the approved reply template.
 */
export function Conversation({ id, onClosed }: { id: string; onClosed?: () => void }) {
  const qc = useQueryClient();
  const thread = useQuery({
    queryKey: ['handoff', id],
    queryFn: () => api.backoffice.handoff(id),
    refetchInterval: 5_000,
  });
  const [text, setText] = useState('');
  const [resolution, setResolution] = useState('');
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['handoff', id] }),
      qc.invalidateQueries({ queryKey: ['inbox'] }),
    ]);
  const onError = (e: unknown) => setError(reasonOf(e));

  const take = useMutation({
    mutationFn: () => api.backoffice.take(id),
    onSuccess: refresh,
    onError,
  });
  const draft = useMutation({
    mutationFn: () => api.backoffice.draft(id),
    onSuccess: (d) => setText(d.text),
    onError,
  });
  const send = useMutation({
    mutationFn: () => api.backoffice.reply(id, text.trim()),
    onSuccess: async () => {
      setText('');
      setError(undefined);
      await refresh();
    },
    onError,
  });
  const giveBack = useMutation({
    mutationFn: () => api.backoffice.giveBack(id, resolution.trim() || undefined),
    onSuccess: async () => {
      await refresh();
      onClosed?.();
    },
    onError,
  });

  if (thread.isPending) return <Empty title="Loading…" />;
  if (thread.isError)
    return <Empty title="Can't open this conversation">{reasonOf(thread.error)}</Empty>;
  const h = thread.data;
  const window = windowOf(h.windowEndsAt);
  const closed = h.state === 'closed';

  return (
    <View className="flex-1 bg-bg">
      <View className="gap-2 border-b border-divider bg-card px-4 py-3">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-heading font-title text-text">
            {h.contact.name ?? `+${h.contact.address}`}
          </Text>
          <Text className="text-small text-muted">+{h.contact.address}</Text>
          <View className="flex-1" />
          {h.state === 'open' ? (
            <Button
              label="Take it"
              tone="primary"
              busy={take.isPending}
              onPress={() => take.mutate()}
            />
          ) : null}
          {!closed ? (
            <Button label="Hand back to assistant" onPress={() => setReturning((r) => !r)} />
          ) : null}
        </View>
        <View className="flex-row flex-wrap gap-2">
          <Badge label={REASONS[h.reason] ?? h.reason} />
          <Badge
            label={window.label}
            tone={
              window.state === 'closing'
                ? 'warn'
                : window.state === 'closed'
                  ? 'neutral'
                  : 'success'
            }
          />
          {h.flagged ? <Badge label="Waiting over a day" tone="danger" /> : null}
          {closed ? <Badge label="Handed back" tone="primary" /> : null}
        </View>
        {returning && !closed ? (
          <View className="gap-2 rounded-control border border-border bg-bg p-3">
            <Text className="text-small text-muted">
              What did you sort out? The assistant reads this before it answers again.
            </Text>
            <TextInput
              accessibilityLabel="What was resolved"
              placeholder="Told them the delivery is on Friday"
              value={resolution}
              onChangeText={setResolution}
              className="min-h-10 rounded-control border border-border bg-card px-3 text-body text-text"
            />
            <View className="flex-row gap-2">
              <Button
                label="Hand back"
                tone="primary"
                busy={giveBack.isPending}
                onPress={() => giveBack.mutate()}
              />
              <Button label="Cancel" tone="quiet" onPress={() => setReturning(false)} />
            </View>
          </View>
        ) : null}
      </View>

      <ScrollView className="flex-1" contentContainerClassName="gap-2 p-4">
        {h.messages.map((m) => (
          <View
            key={m.id}
            className={`max-w-[80%] gap-0.5 rounded-card px-3 py-2 ${m.role === 'user' ? 'self-start border border-border bg-card' : 'self-end bg-agent-bubble'}`}
          >
            <Text className="text-body text-text">{m.text}</Text>
            <Text className="text-small text-muted">
              {m.role === 'user' ? 'Customer' : 'Business'} · {time(m.at)}
            </Text>
          </View>
        ))}
      </ScrollView>

      {!closed ? (
        <View className="gap-2 border-t border-divider bg-card p-3">
          {window.state === 'closed' ? (
            <Text className="text-small text-warn-text">
              Their 24 hours have passed: this goes as the approved reply template, with your words
              inside it.
            </Text>
          ) : null}
          <TextInput
            accessibilityLabel="Reply"
            placeholder="Write a reply…"
            multiline
            value={text}
            onChangeText={setText}
            className="min-h-20 rounded-control border border-border bg-card px-3 py-2 text-body text-text"
          />
          <ErrorLine message={error} />
          <View className="flex-row gap-2">
            <Button label="Suggest a reply" busy={draft.isPending} onPress={() => draft.mutate()} />
            <View className="flex-1" />
            <Button
              label="Send"
              tone="primary"
              disabled={!text.trim()}
              busy={send.isPending}
              onPress={() => send.mutate()}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}
