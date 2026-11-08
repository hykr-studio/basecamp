import { ApiError } from '@hykr/api-client';
import {
  type PrivacyConfiguration,
  type PrivacyIntake,
  PrivacyManageCapability,
  type PrivacyRegister,
  type PrivacyRequest,
  type PrivacyRequestKind,
  type ProcessorRecord,
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

function Chip(props: {
  label: string;
  on: boolean;
  onPress: () => void;
  role?: 'radio' | 'checkbox';
}) {
  return (
    <Pressable
      accessibilityRole={props.role ?? 'radio'}
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
        {r.fiduciary.name} answers for its personal data ·{' '}
        {r.fiduciary.grievanceContact
          ? `contact ${r.fiduciary.grievanceContact}`
          : 'no privacy contact named yet'}
        {r.fiduciary.privacyUrl ? ` · notice ${r.fiduciary.privacyUrl}` : ''}
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

const INPUT = 'min-h-10 rounded-control border border-border bg-card px-3 text-body text-text';
const WHOLE = /^\d{1,5}$/;

/** A retention period as the business sets it: the application's, its own days, or kept. */
type Period = { mode: 'default' | 'days' | 'keep'; days: string };

const periodOf = (v: number | null | undefined): Period =>
  v === undefined
    ? { mode: 'default', days: '' }
    : v === null
      ? { mode: 'keep', days: '' }
      : { mode: 'days', days: String(v) };

const NO_PROCESSOR = { name: '', purpose: '', data: '', location: '', url: '' };

/**
 * The business's own privacy settings: its deadline, the requests that wait for review, how long
 * it keeps each kind of personal data, its own processors and its privacy contact and notice.
 */
function SettingsForm(props: {
  current: PrivacyConfiguration;
  register: PrivacyRegister;
  /** What the last save said: kept above the form, which starts again with the saved values. */
  said?: string;
  onSaid: (said: string | undefined) => void;
}) {
  const { current, register, said, onSaid: setSaid } = props;
  const qc = useQueryClient();
  // Only the periods a business may change: the deployment's are the platform's.
  const targets = register.retention.filter((r) => r.scope === 'tenant');
  const [deadline, setDeadline] = useState(
    current.respondWithinDays ? String(current.respondWithinDays) : '',
  );
  const [review, setReview] = useState<PrivacyRequestKind[]>(current.review);
  const [periods, setPeriods] = useState<Record<string, Period>>(() =>
    Object.fromEntries(targets.map((t) => [t.name, periodOf(current.retention[t.name])])),
  );
  const [processors, setProcessors] = useState<ProcessorRecord[]>(current.processors);
  const [adding, setAdding] = useState(NO_PROCESSOR);
  const [contact, setContact] = useState(current.grievanceContact ?? '');
  const [notice, setNotice] = useState(current.privacyUrl ?? '');
  const invalid =
    (deadline.trim() !== '' && !WHOLE.test(deadline.trim())) ||
    Object.values(periods).some((p) => p.mode === 'days' && !WHOLE.test(p.days.trim()));
  const save = useMutation({
    mutationFn: () => {
      const retention: Record<string, number | null> = {};
      for (const [name, p] of Object.entries(periods))
        if (p.mode === 'keep') retention[name] = null;
        else if (p.mode === 'days') retention[name] = Number(p.days.trim());
      return api.privacy.configure({
        respondWithinDays: deadline.trim() ? Number(deadline.trim()) : null,
        review,
        retention,
        processors,
        // Unchanged, a contact or notice that is the default stays unset.
        ...(contact !== (current.grievanceContact ?? '')
          ? { grievanceContact: contact.trim() || null }
          : {}),
        ...(notice !== (current.privacyUrl ?? '') ? { privacyUrl: notice.trim() || null } : {}),
      });
    },
    onSuccess: () => {
      setSaid('Saved.');
      return qc.invalidateQueries({ queryKey: ['privacy'] });
    },
    onError: () => setSaid(undefined),
  });
  const setPeriod = (name: string, p: Partial<Period>) =>
    setPeriods((all) => ({ ...all, [name]: { ...all[name], ...p } }));
  const add = () => {
    const data = adding.data
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    setProcessors((all) => [
      ...all,
      {
        name: adding.name.trim(),
        purpose: adding.purpose.trim(),
        data,
        ...(adding.location.trim() ? { location: adding.location.trim() } : {}),
        ...(adding.url.trim() ? { url: adding.url.trim() } : {}),
      },
    ]);
    setAdding(NO_PROCESSOR);
  };
  return (
    <View className="gap-4 p-4">
      <View className="gap-1">
        <Text className="text-body font-heading text-text">Answer requests within</Text>
        <TextInput
          accessibilityLabel="Days to answer a request"
          placeholder="Days (empty: the application's deadline)"
          keyboardType="number-pad"
          value={deadline}
          onChangeText={setDeadline}
          className={INPUT}
        />
      </View>
      <View className="gap-1">
        <Text className="text-body font-heading text-text">Wait for review</Text>
        <Text className="text-small text-muted">
          A person's own request of these kinds waits for your team before it runs.
        </Text>
        <View className="flex-row flex-wrap gap-2">
          {(Object.keys(KIND) as PrivacyRequestKind[]).map((k) => (
            <Chip
              key={k}
              role="checkbox"
              label={KIND[k]}
              on={review.includes(k)}
              onPress={() =>
                setReview((r) => (r.includes(k) ? r.filter((x) => x !== k) : [...r, k]))
              }
            />
          ))}
        </View>
      </View>
      <View className="gap-2">
        <Text className="text-body font-heading text-text">Kept for</Text>
        {targets.length === 0 ? (
          <Text className="text-small text-muted">Nothing the business can change.</Text>
        ) : null}
        {targets.map((t) => {
          const p = periods[t.name] ?? periodOf(undefined);
          return (
            <View key={t.name} className="gap-1">
              <Text className="text-small text-text">
                {t.label}
                <Text className="text-muted">
                  {t.defaultDays
                    ? ` · the application keeps it ${t.defaultDays} days`
                    : ' · the application sets no period'}
                </Text>
              </Text>
              <View className="flex-row flex-wrap items-center gap-2">
                <Chip
                  label="As the application"
                  on={p.mode === 'default'}
                  onPress={() => setPeriod(t.name, { mode: 'default' })}
                />
                <Chip
                  label="Days"
                  on={p.mode === 'days'}
                  onPress={() => setPeriod(t.name, { mode: 'days' })}
                />
                <Chip
                  label="Keep it"
                  on={p.mode === 'keep'}
                  onPress={() => setPeriod(t.name, { mode: 'keep' })}
                />
                {p.mode === 'days' ? (
                  <TextInput
                    accessibilityLabel={`Days to keep ${t.label}`}
                    placeholder="Days"
                    keyboardType="number-pad"
                    value={p.days}
                    onChangeText={(days) => setPeriod(t.name, { days })}
                    className={`${INPUT} w-24`}
                  />
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
      <View className="gap-2">
        <Text className="text-body font-heading text-text">Your processors</Text>
        <Text className="text-small text-muted">
          Services you use that receive personal data, besides the application's.
        </Text>
        {processors.map((x, i) => (
          <View key={x.name} className="flex-row items-center gap-2">
            <Text className="flex-1 text-small text-text">
              {x.name}: {x.purpose}
              {x.data.length ? ` (${x.data.join(', ')})` : ''}
              {x.location ? ` · ${x.location}` : ''}
            </Text>
            <Button
              label="Remove"
              tone="quiet"
              onPress={() => setProcessors((all) => all.filter((_, j) => j !== i))}
            />
          </View>
        ))}
        <TextInput
          accessibilityLabel="Processor's name"
          placeholder="Name"
          value={adding.name}
          onChangeText={(name) => setAdding((a) => ({ ...a, name }))}
          className={INPUT}
        />
        <TextInput
          accessibilityLabel="What they do with it"
          placeholder="What they do with the data"
          value={adding.purpose}
          onChangeText={(purpose) => setAdding((a) => ({ ...a, purpose }))}
          className={INPUT}
        />
        <TextInput
          accessibilityLabel="What data they get"
          placeholder="What data they get, separated by commas (optional)"
          value={adding.data}
          onChangeText={(data) => setAdding((a) => ({ ...a, data }))}
          className={INPUT}
        />
        <View className="flex-row gap-2">
          <TextInput
            accessibilityLabel="Where they keep it"
            placeholder="Where they keep it (optional)"
            value={adding.location}
            onChangeText={(location) => setAdding((a) => ({ ...a, location }))}
            className={`${INPUT} flex-1`}
          />
          <TextInput
            accessibilityLabel="Their address"
            placeholder="https://… (optional)"
            autoCapitalize="none"
            value={adding.url}
            onChangeText={(url) => setAdding((a) => ({ ...a, url }))}
            className={`${INPUT} flex-1`}
          />
        </View>
        <Button
          label="Add the processor"
          disabled={
            !adding.name.trim() ||
            !adding.purpose.trim() ||
            processors.some((x) => x.name.toLowerCase() === adding.name.trim().toLowerCase())
          }
          onPress={add}
        />
      </View>
      <View className="gap-1">
        <Text className="text-body font-heading text-text">Privacy contact</Text>
        <Text className="text-small text-muted">
          Who people contact about their personal data: on the register and in WhatsApp's HELP.
        </Text>
        <TextInput
          accessibilityLabel="Privacy contact"
          placeholder="An email, phone number or address"
          autoCapitalize="none"
          value={contact}
          onChangeText={setContact}
          className={INPUT}
        />
        <TextInput
          accessibilityLabel="Privacy notice address"
          placeholder="Your privacy notice, https://…"
          autoCapitalize="none"
          value={notice}
          onChangeText={setNotice}
          className={INPUT}
        />
      </View>
      {said ? <Text className="text-small text-muted">{said}</Text> : null}
      <ErrorLine message={save.isError ? reasonOf(save.error) : undefined} />
      <Button
        label="Save the privacy settings"
        tone="primary"
        disabled={invalid}
        busy={save.isPending}
        onPress={() => save.mutate()}
      />
    </View>
  );
}

/** The form, once the settings and the register are loaded; again after each save. */
function Settings() {
  const [said, setSaid] = useState<string>();
  const current = useQuery({ queryKey: ['privacy', 'settings'], queryFn: api.privacy.settings });
  const register = useQuery({
    queryKey: ['privacy', 'register'],
    queryFn: () => api.privacy.register(),
  });
  if (!current.data || !register.data)
    return (
      <ErrorLine
        message={
          current.isError
            ? reasonOf(current.error)
            : register.isError
              ? reasonOf(register.error)
              : undefined
        }
      />
    );
  return (
    <SettingsForm
      key={`${current.dataUpdatedAt}:${register.dataUpdatedAt}`}
      current={current.data}
      register={register.data}
      said={said}
      onSaid={setSaid}
    />
  );
}

/**
 * Requests about personal data (people with `privacy.manage`): the business's requests, open
 * and past their deadline first; carry one out, refuse it, download a copy; file one someone made
 * by email or phone; the business's own privacy settings; and the register of who holds what.
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
      <Section
        title="Privacy settings"
        hint="How your business answers requests, how long it keeps personal data, and whom people contact."
      >
        <Settings />
      </Section>
      <Section title="Register">
        <Register />
      </Section>
    </ScrollView>
  );
}
