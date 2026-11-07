import { ApiError } from '@hykr/api-client';
import {
  type PrivacyIntake,
  PrivacyManageCapability,
  type PrivacyRequest,
  type PrivacyRequestKind,
  type WriteResult,
} from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { api, reasonOf } from '../api';
import { Badge, Button, Empty, ErrorLine } from '../components/ui';
import { ago } from '../time';

const KIND: Record<PrivacyRequestKind, string> = {
  export: 'Copy of their data',
  erase: 'Erase their data',
};

const STATUS: Record<
  PrivacyRequest['status'],
  { label: string; tone: 'neutral' | 'warn' | 'danger' | 'success' | 'primary' }
> = {
  received: { label: 'waiting for review', tone: 'primary' },
  in_progress: { label: 'in progress', tone: 'warn' },
  completed: { label: 'done', tone: 'success' },
  refused: { label: 'refused', tone: 'neutral' },
  failed: { label: 'failed', tone: 'danger' },
};

const INTAKES: PrivacyIntake[] = ['email', 'phone', 'post', 'in_person', 'other'];

const open = (r: PrivacyRequest) => r.status === 'received' || r.status === 'in_progress';
const waiting = (r: PrivacyRequest) => r.status === 'received' || r.status === 'failed';
const day = (iso: string) => new Date(iso).toLocaleDateString();

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <View className="w-full max-w-3xl gap-2 self-center">
      <View className="gap-0.5">
        <Text className="text-heading font-heading text-text">{title}</Text>
        {hint ? <Text className="text-small text-muted">{hint}</Text> : null}
      </View>
      <View className="overflow-hidden rounded-card border border-border bg-card">{children}</View>
    </View>
  );
}

function Chip(props: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.on }}
      onPress={props.onPress}
      className={`rounded-full border px-2.5 py-1 ${props.on ? 'border-primary bg-primary-tint' : 'border-border bg-card'}`}
    >
      <Text className={`text-small ${props.on ? 'text-primary' : 'text-muted'}`}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** What a write that may wait for an approval says. */
const said = (r: WriteResult<unknown>) =>
  r.status === 'needs_approval' ? 'It waits for a second person to approve it.' : undefined;

/** One request: what, whose, how it came in, its deadline; process, refuse, download. */
function RequestRow({ request }: { request: PrivacyRequest }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [refusing, setRefusing] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const done = (r: WriteResult<unknown>) => {
    setNote(said(r));
    setRefusing(false);
    return qc.invalidateQueries({ queryKey: ['privacy'] });
  };
  const process = useMutation({
    mutationFn: () => api.privacy.process(request.id),
    onSuccess: done,
    onError: (e) => setError(reasonOf(e)),
  });
  const refuse = useMutation({
    mutationFn: () => api.privacy.refuse(request.id, reason.trim()),
    onSuccess: done,
    onError: (e) => setError(reasonOf(e)),
  });
  const download = useMutation({
    mutationFn: async (fileId: string) => {
      const file = await api.files.get(fileId);
      if (!file.url) throw new Error('The archive has no download address');
      await Linking.openURL(file.url);
    },
    onError: (e) => setError(reasonOf(e)),
  });
  const status = STATUS[request.status];
  const late = request.overdueAt && open(request);
  return (
    <View className="gap-2 border-b border-divider px-4 py-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-body font-heading text-text">{KIND[request.kind]}</Text>
        <Badge label={status.label} tone={status.tone} />
        {late ? <Badge label="past its deadline" tone="danger" /> : null}
        <View className="flex-1" />
        <Text className="text-small text-muted">received {ago(request.receivedAt)}</Text>
      </View>
      <Text className="text-small text-muted">
        {request.subject.kind === 'contact' ? 'WhatsApp contact' : 'Person'}{' '}
        {request.subject.id.slice(0, 8)} · by {request.intake.replace('_', ' ')}
        {request.dueAt ? ` · answer by ${day(request.dueAt)}` : ''}
        {request.note ? ` · ${request.note}` : ''}
      </Text>
      {request.reason ? <Text className="text-small text-muted">{request.reason}</Text> : null}
      <View className="flex-row flex-wrap gap-2">
        {waiting(request) ? (
          <Button
            label={request.kind === 'erase' ? 'Erase now' : 'Make the copy'}
            tone="primary"
            busy={process.isPending}
            onPress={() => process.mutate()}
          />
        ) : null}
        {waiting(request) && !refusing ? (
          <Button label="Refuse" tone="quiet" onPress={() => setRefusing(true)} />
        ) : null}
        {request.files.map((id) => (
          <Button
            key={id}
            label="Download the copy"
            busy={download.isPending}
            onPress={() => download.mutate(id)}
          />
        ))}
      </View>
      {refusing ? (
        <View className="gap-2">
          <TextInput
            accessibilityLabel="Why it is refused"
            placeholder="Why it is refused (the person is told)"
            value={reason}
            onChangeText={setReason}
            className="min-h-10 rounded-control border border-border bg-card px-3 text-body text-text"
          />
          <View className="flex-row gap-2">
            <Button
              label="Refuse"
              tone="danger"
              disabled={!reason.trim()}
              busy={refuse.isPending}
              onPress={() => refuse.mutate()}
            />
            <Button label="Cancel" tone="quiet" onPress={() => setRefusing(false)} />
          </View>
        </View>
      ) : null}
      {note ? <Text className="text-small text-muted">{note}</Text> : null}
      <ErrorLine message={error} />
    </View>
  );
}

/** File a request someone made by email, phone or post, for them. */
function FileRequest() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<PrivacyRequestKind>('export');
  const [who, setWho] = useState('');
  const [intake, setIntake] = useState<PrivacyIntake>('email');
  const [note, setNote] = useState('');
  const [said, setSaid] = useState<string>();
  const [error, setError] = useState<string>();
  const file = useMutation({
    mutationFn: () => {
      const value = who.trim();
      const target = value.includes('@')
        ? { email: value }
        : { address: value.replace(/[\s-]/g, '') };
      return api.privacy.request({
        kind,
        for: target,
        intake,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    },
    onSuccess: (r) => {
      setError(undefined);
      setSaid(
        r.status === 'needs_approval'
          ? 'Filed. It waits for a second person to approve it.'
          : 'Filed.',
      );
      setWho('');
      setNote('');
      return qc.invalidateQueries({ queryKey: ['privacy'] });
    },
    onError: (e) => {
      setSaid(undefined);
      setError(
        e instanceof ApiError && e.status === 404
          ? 'The business does not know anyone by that email or number'
          : reasonOf(e),
      );
    },
  });
  return (
    <View className="gap-3 p-4">
      <View className="flex-row flex-wrap gap-2">
        {(Object.keys(KIND) as PrivacyRequestKind[]).map((k) => (
          <Chip key={k} label={KIND[k]} on={kind === k} onPress={() => setKind(k)} />
        ))}
      </View>
      <TextInput
        accessibilityLabel="Their email or WhatsApp number"
        placeholder="Their email, or their WhatsApp number"
        autoCapitalize="none"
        value={who}
        onChangeText={setWho}
        className="min-h-10 rounded-control border border-border bg-card px-3 text-body text-text"
      />
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-small text-muted">They asked by</Text>
        {INTAKES.map((i) => (
          <Chip
            key={i}
            label={i.replace('_', ' ')}
            on={intake === i}
            onPress={() => setIntake(i)}
          />
        ))}
      </View>
      <TextInput
        accessibilityLabel="A note for the team"
        placeholder="A note for the team (optional)"
        value={note}
        onChangeText={setNote}
        className="min-h-10 rounded-control border border-border bg-card px-3 text-body text-text"
      />
      {said ? <Text className="text-small text-muted">{said}</Text> : null}
      <ErrorLine message={error} />
      <Button
        label="File the request"
        tone="primary"
        disabled={!who.trim()}
        busy={file.isPending}
        onPress={() => file.mutate()}
      />
    </View>
  );
}

/** Who holds the business's personal data, what, for how long. */
function Register() {
  const register = useQuery({
    queryKey: ['privacy', 'register'],
    queryFn: () => api.privacy.register(),
  });
  if (!register.data)
    return <ErrorLine message={register.isError ? reasonOf(register.error) : undefined} />;
  const r = register.data;
  return (
    <View className="gap-3 p-4">
      <Text className="text-small text-muted">
        {r.fiduciary.name} answers for its personal data · contact {r.fiduciary.grievanceContact}
        {r.requests.respondWithinDays
          ? ` · requests answered within ${r.requests.respondWithinDays} days`
          : ' · no deadline set for requests'}
      </Text>
      <Text className="text-body font-heading text-text">Processors</Text>
      {r.processors.length === 0 ? (
        <Text className="text-small text-muted">None listed.</Text>
      ) : null}
      {r.processors.map((p) => (
        <Text key={`${p.source}:${p.name}`} className="text-small text-text">
          {p.name}: {p.purpose}
          {p.data.length ? ` (${p.data.join(', ')})` : ''}
          {p.source === 'business' ? ' · added by the business' : ''}
        </Text>
      ))}
      <Text className="text-body font-heading text-text">Personal data</Text>
      {r.records.map((x) => (
        <Text key={x.entity} className="text-small text-text">
          {x.label}: {x.fields.map((f) => f.label).join(', ')} ·{' '}
          {x.erase === 'keep' ? `kept on erasure (${x.keepReason})` : `${x.erase}d on erasure`}
        </Text>
      ))}
      <Text className="text-body font-heading text-text">Kept for</Text>
      {r.retention.map((x) => (
        <Text key={x.name} className="text-small text-text">
          {x.label}: {x.days ? `${x.days} days` : 'no period set (kept)'}
        </Text>
      ))}
    </View>
  );
}

/**
 * Requests about personal data (people with `privacy.manage`): the business's requests, open
 * and past their deadline first; carry one out, refuse it, download a copy; file one someone made
 * by email or phone; and the register of who holds what.
 */
export function PrivacyScreen() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const requests = useQuery({
    queryKey: ['privacy', 'requests'],
    queryFn: () => api.privacy.list({ limit: 100 }),
    refetchInterval: (q) =>
      (q.state.data as PrivacyRequest[] | undefined)?.some((r) => r.status === 'in_progress')
        ? 2_000
        : false,
    enabled: me.data?.capabilities.includes(PrivacyManageCapability.name) ?? false,
  });
  if (me.isPending) return <Empty title="Loading…" />;
  if (!me.data?.capabilities.includes(PrivacyManageCapability.name))
    return <Empty title="Not for your role">Handling privacy requests needs privacy.manage.</Empty>;
  const items = [...(requests.data ?? [])].sort(
    (a, b) =>
      Number(open(b)) - Number(open(a)) ||
      Number(!!b.overdueAt) - Number(!!a.overdueAt) ||
      b.receivedAt.localeCompare(a.receivedAt),
  );
  return (
    <ScrollView contentContainerClassName="gap-6 p-4">
      <Section
        title="Privacy requests"
        hint="People's requests for a copy of their personal data, or to be forgotten."
      >
        {requests.isError ? <ErrorLine message={reasonOf(requests.error)} /> : null}
        {items.length === 0 && !requests.isPending ? (
          <Text className="p-4 text-small text-muted">No requests yet.</Text>
        ) : null}
        {items.map((r) => (
          <RequestRow key={`${r.id}:${r.status}`} request={r} />
        ))}
      </Section>
      <Section
        title="File a request"
        hint="Someone asked by email, phone or post: file it for them. An erasure cannot be undone."
      >
        <FileRequest />
      </Section>
      <Section title="Register">
        <Register />
      </Section>
    </ScrollView>
  );
}
