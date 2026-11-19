import { type ApiClient, ApiError } from '@hykr/api-client';
import type { CapabilityView, Invite, Member, RoleView } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { api, reasonOf } from '../api';
import { Badge, Button, Empty, ErrorLine } from '../components/ui';

type Me = Awaited<ReturnType<ApiClient['me']>>;

/** One role or capability the person can switch on or off. */
function Chip(props: { label: string; on: boolean; onPress?: () => void; hint?: string }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.on, disabled: !props.onPress }}
      accessibilityHint={props.hint}
      disabled={!props.onPress}
      onPress={props.onPress}
      className={`rounded-full border px-2.5 py-1 ${props.on ? 'border-primary bg-primary-tint' : 'border-border bg-card'} ${props.onPress ? '' : 'opacity-60'}`}
    >
      <Text className={`text-small ${props.on ? 'text-primary' : 'text-muted'}`}>
        {props.label}
      </Text>
    </Pressable>
  );
}

const toggle = (list: string[], name: string) =>
  list.includes(name) ? list.filter((x) => x !== name) : [...list, name];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="w-full max-w-3xl gap-2 self-center">
      <Text className="text-heading font-heading text-text">{title}</Text>
      <View className="overflow-hidden rounded-card border border-border bg-card">{children}</View>
    </View>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <TextInput
      accessibilityLabel={props.label}
      placeholder={props.placeholder ?? props.label}
      autoCapitalize="none"
      value={props.value}
      onChangeText={props.onChange}
      className="min-h-9 flex-1 rounded-control border border-border bg-card px-3 text-body text-text"
    />
  );
}

/** A member: their roles, which a manager switches on and off, and removal. */
function MemberRow(props: { member: Member; roles: RoleView[]; manage: boolean; you: boolean }) {
  const { member, roles, manage } = props;
  const client = useQueryClient();
  const [held, setHeld] = useState(member.roles);
  const [error, setError] = useState<string>();
  const changed = held.join() !== member.roles.join();
  const done = () => client.invalidateQueries({ queryKey: ['members'] });
  const save = useMutation({
    mutationFn: () => api.members.setRoles(member.userId, held),
    onSuccess: done,
    onError: (e) => setError(reasonOf(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.members.remove(member.userId),
    onSuccess: done,
    onError: (e) => setError(reasonOf(e)),
  });
  return (
    <View className="gap-2 border-b border-divider px-4 py-3">
      <View className="flex-row items-center gap-2">
        <View className="flex-1">
          <Text className="text-body font-heading text-text">
            {member.name}
            {props.you ? ' (you)' : ''}
          </Text>
          <Text className="text-small text-muted">{member.email}</Text>
        </View>
        {manage && changed ? (
          <Button
            label="Save roles"
            tone="primary"
            busy={save.isPending}
            onPress={() => save.mutate()}
          />
        ) : null}
        {manage && !props.you ? (
          <Button
            label="Remove"
            tone="danger"
            busy={remove.isPending}
            onPress={() => remove.mutate()}
          />
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-1.5">
        {roles.map((r) => (
          <Chip
            key={r.name}
            label={r.label.en}
            on={held.includes(r.name)}
            onPress={manage ? () => setHeld(toggle(held, r.name)) : undefined}
          />
        ))}
      </View>
      <ErrorLine message={error} />
    </View>
  );
}

/** Invite by email with roles; the code is shown once, to share with the person. */
function Invites({ roles }: { roles: RoleView[] }) {
  const client = useQueryClient();
  const invites = useQuery({ queryKey: ['members', 'invites'], queryFn: api.members.invites });
  const [email, setEmail] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [code, setCode] = useState<string>();
  const [error, setError] = useState<string>();
  const send = useMutation({
    mutationFn: () => api.members.invite({ email: email.trim(), roles: picked }),
    onSuccess: (res) => {
      if (res.status === 'done') setCode(res.value.token);
      setEmail('');
      setPicked([]);
      setError(undefined);
      client.invalidateQueries({ queryKey: ['members', 'invites'] });
    },
    onError: (e) => setError(reasonOf(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.members.revokeInvite(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['members', 'invites'] }),
    onError: (e) => setError(reasonOf(e)),
  });
  const pending = (i: Invite) =>
    !i.acceptedAt && !i.revokedAt && i.expiresAt > new Date().toISOString();
  return (
    <Section title="Invitations">
      <View className="gap-2 border-b border-divider px-4 py-3">
        <View className="flex-row gap-2">
          <Field label="Email" value={email} onChange={setEmail} placeholder="name@example.com" />
          <Button
            label="Invite"
            tone="primary"
            disabled={!email.trim() || picked.length === 0}
            busy={send.isPending}
            onPress={() => send.mutate()}
          />
        </View>
        <View className="flex-row flex-wrap gap-1.5">
          {roles.map((r) => (
            <Chip
              key={r.name}
              label={r.label.en}
              on={picked.includes(r.name)}
              onPress={() => setPicked(toggle(picked, r.name))}
            />
          ))}
        </View>
        {code ? (
          <View className="gap-1 rounded-control bg-primary-tint p-3">
            <Text className="text-small text-text">
              Share this code with them. They sign in with that email and enter it here. It is shown
              only now.
            </Text>
            <Text selectable className="font-heading text-body text-primary">
              {code}
            </Text>
          </View>
        ) : null}
        <ErrorLine message={error} />
      </View>
      {(invites.data ?? []).map((i) => (
        <View key={i.id} className="flex-row items-center gap-3 border-b border-divider px-4 py-3">
          <View className="flex-1 gap-0.5">
            <Text className="text-body text-text">{i.email}</Text>
            <Text className="text-small text-muted">
              {i.roles.join(', ')} · until {i.expiresAt.slice(0, 10)}
            </Text>
          </View>
          {i.acceptedAt ? <Badge label="joined" tone="success" /> : null}
          {i.revokedAt ? <Badge label="taken back" /> : null}
          {pending(i) ? (
            <Button label="Take back" tone="quiet" onPress={() => revoke.mutate(i.id)} />
          ) : null}
        </View>
      ))}
    </Section>
  );
}

/** One role: its capabilities, switched on and off by a manager; reset or delete. */
function RoleRow(props: { role: RoleView; capabilities: CapabilityView[]; manage: boolean }) {
  const { role, capabilities, manage } = props;
  const client = useQueryClient();
  const [held, setHeld] = useState(role.capabilities);
  const [error, setError] = useState<string>();
  const changed = [...held].sort().join() !== role.capabilities.join();
  const done = () => client.invalidateQueries({ queryKey: ['members'] });
  const save = useMutation({
    mutationFn: () => api.members.editRole(role.name, { capabilities: held }),
    onSuccess: done,
    onError: (e) => setError(reasonOf(e)),
  });
  const reset = useMutation({
    mutationFn: () => api.members.removeRole(role.name),
    onSuccess: done,
    onError: (e) => setError(reasonOf(e)),
  });
  const own = role.source === 'business';
  return (
    <View className="gap-2 border-b border-divider px-4 py-3">
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-body font-heading text-text">
          {role.label.en} <Text className="text-small text-muted">({role.name})</Text>
        </Text>
        <Badge label={own ? 'this business' : role.edited ? 'changed here' : role.source} />
        {manage && changed ? (
          <Button label="Save" tone="primary" busy={save.isPending} onPress={() => save.mutate()} />
        ) : null}
        {manage && (own || role.edited) ? (
          <Button
            label={own ? 'Delete' : 'Reset'}
            tone="danger"
            busy={reset.isPending}
            onPress={() => reset.mutate()}
          />
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-1.5">
        {capabilities.map((c) => (
          <Chip
            key={c.name}
            label={c.label.en}
            hint={c.name}
            on={held.includes(c.name)}
            onPress={
              manage && (c.grantable || held.includes(c.name))
                ? () => setHeld(toggle(held, c.name))
                : undefined
            }
          />
        ))}
      </View>
      <ErrorLine message={error} />
    </View>
  );
}

function NewRole({ capabilities }: { capabilities: CapabilityView[] }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [held, setHeld] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const define = useMutation({
    mutationFn: () =>
      api.members.defineRole({
        name: name.trim(),
        label: { en: label.trim() },
        capabilities: held,
      }),
    onSuccess: () => {
      setName('');
      setLabel('');
      setHeld([]);
      setError(undefined);
      client.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (e) => setError(reasonOf(e)),
  });
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-small font-heading text-text">A new role for this business</Text>
      <View className="flex-row gap-2">
        <Field label="Name" value={name} onChange={setName} placeholder="name (lower_case)" />
        <Field label="Label" value={label} onChange={setLabel} placeholder="What people call it" />
        <Button
          label="Add role"
          tone="primary"
          disabled={!name.trim() || !label.trim()}
          busy={define.isPending}
          onPress={() => define.mutate()}
        />
      </View>
      <View className="flex-row flex-wrap gap-1.5">
        {capabilities
          .filter((c) => c.grantable)
          .map((c) => (
            <Chip
              key={c.name}
              label={c.label.en}
              hint={c.name}
              on={held.includes(c.name)}
              onPress={() => setHeld(toggle(held, c.name))}
            />
          ))}
      </View>
      <ErrorLine message={error} />
    </View>
  );
}

/**
 * The business's people and roles: who is in it with which roles, invitations, and the roles
 * themselves (the application's, as this business changed them, and its own). Reading needs
 * `members.read`; changing anything `members.manage`, which the server checks again.
 */
export function MembersScreen() {
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  const members = useQuery({ queryKey: ['members', 'list'], queryFn: api.members.list });
  const roles = useQuery({ queryKey: ['members', 'roles'], queryFn: api.members.roles });
  const manage = me.data?.capabilities.includes('members.manage') ?? false;
  if (members.isPending || roles.isPending) return <Empty title="Loading…" />;
  if (members.isError || roles.isError) {
    const error = members.error ?? roles.error;
    return (
      <Empty
        title={
          error instanceof ApiError && error.status === 403
            ? 'Not for your role'
            : "Can't load members"
        }
      >
        {reasonOf(error)}
      </Empty>
    );
  }
  const { roles: all, capabilities } = roles.data;
  return (
    <ScrollView contentContainerClassName="gap-6 p-4">
      <Section title="Members">
        {members.data.map((m) => (
          <MemberRow
            key={`${m.userId}:${m.roles.join()}`}
            member={m}
            roles={all}
            manage={manage}
            you={m.userId === me.data?.userId}
          />
        ))}
      </Section>
      {manage ? <Invites roles={all} /> : null}
      <Section title="Roles">
        {all.map((r) => (
          <RoleRow
            key={`${r.name}:${r.capabilities.join()}`}
            role={r}
            capabilities={capabilities}
            manage={manage}
          />
        ))}
        {manage ? <NewRole capabilities={capabilities} /> : null}
      </Section>
    </ScrollView>
  );
}
