import { ApiError } from '@hykr/api-client';
import type { SupportGrant } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { api, reasonOf } from '../api';
import { Badge, Button, Empty, ErrorLine } from '../components/ui';
import { time } from '../time';

const TONE = {
  requested: 'warn',
  active: 'success',
  declined: 'neutral',
  expired: 'neutral',
  ended: 'neutral',
  revoked: 'danger',
} as const;

/** One request for support access: what it asks, consent (maybe shorter or read only), end it. */
function GrantRow({ grant }: { grant: SupportGrant }) {
  const client = useQueryClient();
  const [minutes, setMinutes] = useState(String(grant.minutes));
  const [readOnly, setReadOnly] = useState(grant.access === 'read');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const done = () => client.invalidateQueries({ queryKey: ['support-access'] });
  const act = useMutation({
    mutationFn: (what: 'consent' | 'decline' | 'revoke') =>
      what === 'consent'
        ? api.supportAccess.consent(grant.id, {
            minutes: Number(minutes),
            ...(readOnly ? { access: 'read' as const } : {}),
          })
        : what === 'decline'
          ? api.supportAccess.decline(grant.id)
          : api.supportAccess.revoke(grant.id),
    onSuccess: () => {
      setError(undefined);
      done();
    },
    onError: (e) => setError(reasonOf(e)),
  });
  const activity = useQuery({
    queryKey: ['support-access', grant.id, 'activity'],
    queryFn: () => api.supportAccess.activity(grant.id),
    enabled: open,
  });
  return (
    <View className="gap-2 border-b border-divider px-4 py-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge label={grant.status} tone={TONE[grant.status]} />
        <Text className="flex-1 text-body text-text">
          {grant.operator.name} ({grant.operator.email}): {grant.reason}
        </Text>
        <Button
          label={open ? 'Hide activity' : 'Activity'}
          tone="quiet"
          onPress={() => setOpen(!open)}
        />
      </View>
      <Text className="text-small text-muted">
        Asks to {grant.access === 'write' ? 'read and change' : 'read'} as {grant.roles.join(', ')}
        {grant.capabilities.length ? `, with ${grant.capabilities.join(', ')}` : ''}, for{' '}
        {grant.minutes} minutes · asked {time(grant.requestedAt)}
        {grant.endsAt ? ` · until ${time(grant.endsAt)}` : ''}
      </Text>
      {grant.status === 'requested' ? (
        <View className="flex-row flex-wrap items-center gap-2">
          <TextInput
            accessibilityLabel="Minutes to allow"
            value={minutes}
            onChangeText={setMinutes}
            className="min-h-9 w-24 rounded-control border border-border bg-card px-3 text-body text-text"
          />
          {grant.access === 'write' ? (
            <Button
              label={readOnly ? 'Read only' : 'Read and change'}
              tone="quiet"
              onPress={() => setReadOnly(!readOnly)}
            />
          ) : null}
          <Button
            label="Let them in"
            tone="primary"
            disabled={!Number(minutes)}
            busy={act.isPending}
            onPress={() => act.mutate('consent')}
          />
          <Button label="Decline" busy={act.isPending} onPress={() => act.mutate('decline')} />
        </View>
      ) : null}
      {grant.status === 'active' ? (
        <Button
          label="End access now"
          tone="danger"
          busy={act.isPending}
          onPress={() => act.mutate('revoke')}
        />
      ) : null}
      {open
        ? (activity.data ?? []).map((a) => (
            <Text key={a.id} className="text-small text-muted">
              {time(a.at)} {a.method} {a.path} → {a.status}
              {a.actorKind === 'agent' ? ' (assistant)' : ''}
            </Text>
          ))
        : null}
      <ErrorLine message={error} />
    </View>
  );
}

/** Whether operators may ask at all, and the longest access the business allows. */
function Settings() {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ['support-access', 'settings'],
    queryFn: api.supportAccess.settings,
  });
  const [max, setMax] = useState<string>();
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: (s: { requests: boolean; maxMinutes: number; requestHours: number }) =>
      api.supportAccess.setSettings(s),
    onSuccess: () => {
      setError(undefined);
      client.invalidateQueries({ queryKey: ['support-access', 'settings'] });
    },
    onError: (e) => setError(reasonOf(e)),
  });
  const s = settings.data;
  if (!s) return null;
  return (
    <View className="gap-2 px-4 py-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-body text-text">
          {s.requests ? 'Operators may ask for access.' : 'Operators may not ask for access.'}
        </Text>
        <Button
          label={s.requests ? 'Stop requests' : 'Allow requests'}
          busy={save.isPending}
          onPress={() => save.mutate({ ...s, requests: !s.requests })}
        />
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-body text-text">At most</Text>
        <TextInput
          accessibilityLabel="Longest access, in minutes"
          value={max ?? String(s.maxMinutes)}
          onChangeText={setMax}
          className="min-h-9 w-24 rounded-control border border-border bg-card px-3 text-body text-text"
        />
        <Text className="text-body text-text">minutes</Text>
        {max !== undefined && Number(max) !== s.maxMinutes ? (
          <Button
            label="Save"
            tone="primary"
            disabled={!Number(max)}
            busy={save.isPending}
            onPress={() => save.mutate({ ...s, maxMinutes: Number(max) })}
          />
        ) : null}
      </View>
      <ErrorLine message={error} />
    </View>
  );
}

/**
 * Support access (B19), from the business's side: what the platform's operators asked, letting
 * them in (for as long as you say, read only if you like), declining, ending it, and every
 * request they made. Needs `support.consent`; the server checks again.
 */
export function SupportAccessScreen() {
  const grants = useQuery({
    queryKey: ['support-access', 'list'],
    queryFn: api.supportAccess.list,
  });
  if (grants.isPending) return <Empty title="Loading…" />;
  if (grants.isError)
    return (
      <Empty
        title={
          grants.error instanceof ApiError && grants.error.status === 403
            ? 'Not for your role'
            : "Can't load support access"
        }
      >
        {reasonOf(grants.error)}
      </Empty>
    );
  return (
    <ScrollView contentContainerClassName="gap-6 p-4">
      <View className="w-full max-w-3xl gap-2 self-center">
        <Text className="text-heading font-heading text-text">Support access</Text>
        <Text className="text-small text-muted">
          The platform's operators work in your business only when you let them, for the time you
          allow. Everything they do is recorded.
        </Text>
        <View className="overflow-hidden rounded-card border border-border bg-card">
          {grants.data.length === 0 ? <Empty title="No requests" /> : null}
          {grants.data.map((g) => (
            <GrantRow key={`${g.id}:${g.status}`} grant={g} />
          ))}
          <Settings />
        </View>
      </View>
    </ScrollView>
  );
}
