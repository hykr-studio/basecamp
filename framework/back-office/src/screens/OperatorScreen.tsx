import { ApiError } from '@hykr/api-client';
import type { Operator, PlatformTenant, SupportGrant } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { api, reasonOf, workIn } from '../api';
import { Badge, Button, Empty, ErrorLine } from '../components/ui';
import { time as shortTime } from '../time';

const SUPPORT = 'platform.support';
const TENANTS = 'platform.tenants';
const USAGE = 'platform.usage';
const ROUTING = 'platform.routing';
const OPERATORS = 'platform.operators';

function Section(props: { title: string; hint?: string; children: ReactNode }) {
  return (
    <View className="w-full max-w-4xl gap-2 self-center">
      <View className="gap-0.5">
        <Text className="text-heading font-heading text-text">{props.title}</Text>
        {props.hint ? <Text className="text-small text-muted">{props.hint}</Text> : null}
      </View>
      <View className="overflow-hidden rounded-card border border-border bg-card">
        {props.children}
      </View>
    </View>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: string;
}) {
  return (
    <TextInput
      accessibilityLabel={props.label}
      placeholder={props.placeholder ?? props.label}
      autoCapitalize="none"
      value={props.value}
      onChangeText={props.onChange}
      className={`min-h-9 rounded-control border border-border bg-card px-3 text-body text-text ${props.width ?? 'flex-1'}`}
    />
  );
}

const Row = ({ children }: { children: ReactNode }) => (
  <View className="flex-row flex-wrap items-center gap-2 border-b border-divider px-4 py-3">
    {children}
  </View>
);

const words = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const STATUS_TONE = {
  requested: 'warn',
  active: 'success',
  declined: 'neutral',
  expired: 'neutral',
  ended: 'neutral',
  revoked: 'danger',
} as const;

/** Businesses: find one, make one for a person, rename it, switch a platform-managed flag. */
function Businesses({ onWork }: { onWork: (t: PlatformTenant) => void }) {
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['platform', 'tenants', q],
    queryFn: () => api.platform.tenants(q.trim() ? { q: q.trim() } : {}),
  });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<string>();
  const provision = useMutation({
    mutationFn: () => api.platform.provision({ name: name.trim(), owner: { email: email.trim() } }),
    onSuccess: (r) => {
      setError(undefined);
      setMade(r.status === 'done' ? `Made ${r.value.name} for ${email.trim()}` : undefined);
      setName('');
      setEmail('');
      client.invalidateQueries({ queryKey: ['platform', 'tenants'] });
    },
    onError: (e) => setError(reasonOf(e)),
  });
  return (
    <Section
      title="Businesses"
      hint="Make a business for a person who signed up: they become its owner."
    >
      <Row>
        <Field label="Find a business" value={q} onChange={setQ} placeholder="Find by name" />
      </Row>
      {(list.data?.items ?? []).map((t) => (
        <TenantRow key={t.id} tenant={t} onWork={onWork} />
      ))}
      {list.isError ? (
        <Row>
          <ErrorLine message={reasonOf(list.error)} />
        </Row>
      ) : null}
      <Row>
        <Field label="Business name" value={name} onChange={setName} />
        <Field label="Owner's email" value={email} onChange={setEmail} />
        <Button
          label="Make business"
          tone="primary"
          disabled={!name.trim() || !email.trim()}
          busy={provision.isPending}
          onPress={() => provision.mutate()}
        />
      </Row>
      {made || error ? (
        <View className="px-4 py-2">
          {made ? <Text className="text-small text-success">{made}</Text> : null}
          <ErrorLine message={error} />
        </View>
      ) : null}
    </Section>
  );
}

function TenantRow({
  tenant,
  onWork,
}: {
  tenant: PlatformTenant;
  onWork: (t: PlatformTenant) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(tenant.name);
  const [flag, setFlag] = useState('');
  const [error, setError] = useState<string>();
  const [said, setSaid] = useState<string>();
  const rename = useMutation({
    mutationFn: () => api.platform.rename(tenant.id, name.trim()),
    onSuccess: () => client.invalidateQueries({ queryKey: ['platform', 'tenants'] }),
    onError: (e) => setError(reasonOf(e)),
  });
  const switchFlag = useMutation({
    mutationFn: (on: boolean) => api.platform.setFeature(tenant.id, flag.trim(), on),
    onSuccess: (_r, on) => {
      setError(undefined);
      setSaid(`${flag.trim()} is ${on ? 'on' : 'off'}`);
    },
    onError: (e) => setError(reasonOf(e)),
  });
  return (
    <View className="gap-2 border-b border-divider px-4 py-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Field label={`Name of ${tenant.name}`} value={name} onChange={setName} />
        <Text className="text-small text-muted">
          {tenant.members} member{tenant.members === 1 ? '' : 's'} · since{' '}
          {shortTime(tenant.createdAt)}
        </Text>
        {name.trim() && name.trim() !== tenant.name ? (
          <Button label="Rename" busy={rename.isPending} onPress={() => rename.mutate()} />
        ) : null}
        <Button label="Ask for support access" tone="quiet" onPress={() => onWork(tenant)} />
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Field
          label={`A feature flag of ${tenant.name}`}
          value={flag}
          onChange={setFlag}
          placeholder="Feature flag key"
          width="w-56"
        />
        <Button
          label="Switch on"
          disabled={!flag.trim()}
          busy={switchFlag.isPending}
          onPress={() => switchFlag.mutate(true)}
        />
        <Button
          label="Switch off"
          disabled={!flag.trim()}
          busy={switchFlag.isPending}
          onPress={() => switchFlag.mutate(false)}
        />
        {said ? <Text className="text-small text-muted">{said}</Text> : null}
      </View>
      <ErrorLine message={error} />
    </View>
  );
}

/** Ask a business for access, see each grant's status, work in an active one, end it. */
function Support({
  asking,
  onWorkIn,
}: {
  asking?: PlatformTenant;
  onWorkIn: (g: SupportGrant) => void;
}) {
  const client = useQueryClient();
  const grants = useQuery({
    queryKey: ['platform', 'support'],
    queryFn: () => api.platform.support(),
  });
  const [tenantId, setTenantId] = useState(asking?.id ?? '');
  const [reason, setReason] = useState('');
  const [roles, setRoles] = useState('admin');
  const [capabilities, setCapabilities] = useState('backoffice.use');
  const [minutes, setMinutes] = useState('60');
  const [write, setWrite] = useState(false);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  if (asking && tenantId !== asking.id && !reason) setTenantId(asking.id);
  const ask = useMutation({
    mutationFn: () =>
      api.platform.askSupport({
        tenantId: tenantId.trim(),
        reason: reason.trim(),
        roles: words(roles),
        capabilities: words(capabilities),
        access: write ? 'write' : 'read',
        minutes: Number(minutes),
      }),
    onSuccess: () => {
      setError(undefined);
      setReason('');
      client.invalidateQueries({ queryKey: ['platform', 'support'] });
    },
    onError: (e) => setError(reasonOf(e)),
  });
  const end = useMutation({
    mutationFn: (id: string) => api.platform.endSupport(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['platform', 'support'] }),
    onError: (e) => setError(reasonOf(e)),
  });
  const activity = useQuery({
    queryKey: ['platform', 'support', open, 'activity'],
    queryFn: () => api.platform.supportActivity(open as string),
    enabled: !!open,
  });
  return (
    <Section
      title="Support access"
      hint="A business consents first. Access is read only unless you ask to write, and every request is logged for the business."
    >
      {(grants.data ?? []).map((g) => (
        <View key={g.id} className="gap-1 border-b border-divider px-4 py-3">
          <View className="flex-row flex-wrap items-center gap-2">
            <Badge label={g.status} tone={STATUS_TONE[g.status]} />
            <Text className="flex-1 text-body text-text">{g.reason}</Text>
            {g.status === 'active' ? (
              <Button label="Work here" tone="primary" onPress={() => onWorkIn(g)} />
            ) : null}
            {g.status === 'active' || g.status === 'requested' ? (
              <Button label="End" tone="danger" onPress={() => end.mutate(g.id)} />
            ) : null}
            <Button
              label={open === g.id ? 'Hide activity' : 'Activity'}
              tone="quiet"
              onPress={() => setOpen(open === g.id ? undefined : g.id)}
            />
          </View>
          <Text className="text-small text-muted">
            {g.access === 'write' ? 'Read and write' : 'Read only'} as {g.roles.join(', ')}
            {g.capabilities.length ? `, with ${g.capabilities.join(', ')}` : ''} · {g.minutes} min
            {g.endsAt ? ` · until ${shortTime(g.endsAt)}` : ''} · business {g.tenantId}
          </Text>
          {open === g.id
            ? (activity.data ?? []).map((a) => (
                <Text key={a.id} className="text-small text-muted">
                  {shortTime(a.at)} {a.method} {a.path} → {a.status}
                  {a.actorKind === 'agent' ? ' (assistant)' : ''}
                </Text>
              ))
            : null}
        </View>
      ))}
      <View className="gap-2 px-4 py-3">
        <View className="flex-row flex-wrap gap-2">
          <Field label="Business id" value={tenantId} onChange={setTenantId} />
          <Field
            label="Why"
            value={reason}
            onChange={setReason}
            placeholder="Why you need access"
          />
        </View>
        <View className="flex-row flex-wrap items-center gap-2">
          <Field
            label="Roles"
            value={roles}
            onChange={setRoles}
            placeholder="Roles, comma separated"
          />
          <Field
            label="Capabilities"
            value={capabilities}
            onChange={setCapabilities}
            placeholder="Capabilities, comma separated"
          />
          <Field label="Minutes" value={minutes} onChange={setMinutes} width="w-24" />
          <Button
            label={write ? 'Read and write' : 'Read only'}
            tone="quiet"
            onPress={() => setWrite(!write)}
          />
          <Button
            label="Ask"
            tone="primary"
            disabled={!tenantId.trim() || reason.trim().length < 3 || !Number(minutes)}
            busy={ask.isPending}
            onPress={() => ask.mutate()}
          />
        </View>
        <ErrorLine message={error} />
      </View>
    </Section>
  );
}

/** What every business used over a range of days, as recorded. */
function Usage() {
  const month = new Date().toISOString().slice(0, 8);
  const [from, setFrom] = useState(`${month}01`);
  const [to, setTo] = useState('');
  const report = useQuery({
    queryKey: ['platform', 'usage', from, to],
    queryFn: () => api.platform.usage({ ...(from ? { from } : {}), ...(to ? { to } : {}) }),
  });
  return (
    <Section title="Usage" hint="Quantities and credits as each business's meters recorded them.">
      <Row>
        <Field label="From (YYYY-MM-DD)" value={from} onChange={setFrom} width="w-40" />
        <Field
          label="To (YYYY-MM-DD, not included)"
          value={to}
          onChange={setTo}
          placeholder="To (default: a month on)"
          width="w-56"
        />
      </Row>
      {report.isError ? (
        <Row>
          <ErrorLine message={reasonOf(report.error)} />
        </Row>
      ) : null}
      {(report.data?.tenants ?? []).map((t) => (
        <View key={t.tenantId} className="gap-0.5 border-b border-divider px-4 py-2">
          <Text className="text-body font-heading text-text">{t.name}</Text>
          <Text className="text-small text-muted">
            {t.meters.length
              ? t.meters.map((m) => `${m.meter} ${m.quantity} (${m.cost} credits)`).join(' · ')
              : 'Nothing metered'}
            {t.wallet
              ? ` · wallet ${t.wallet.balance} ${t.wallet.currency}, in ${t.wallet.topups + t.wallet.grants}, out ${t.wallet.debits}`
              : ''}
          </Text>
        </View>
      ))}
      {report.data?.totals.length ? (
        <View className="px-4 py-2">
          <Text className="text-small text-text">
            Total:{' '}
            {report.data.totals.map((m) => `${m.meter} ${m.quantity} (${m.cost})`).join(' · ')}
          </Text>
        </View>
      ) : null}
    </Section>
  );
}

/** Inbound requests the platform routed (or could not). */
function Routing() {
  const log = useQuery({
    queryKey: ['platform', 'routing'],
    queryFn: () => api.platform.routing(),
  });
  return (
    <Section title="Routed requests" hint="Which business each inbound request went to.">
      {(log.data ?? []).length === 0 ? <Empty title="Nothing routed yet" /> : null}
      {(log.data ?? []).map((r) => (
        <Row key={r.id}>
          <Badge
            label={r.status}
            tone={r.status === 'routed' ? 'success' : r.status === 'failed' ? 'danger' : 'neutral'}
          />
          <Text className="flex-1 text-small text-text">
            {r.source} {r.ref} → {r.tenantId ?? 'nobody'}
            {r.resourceType ? ` (${r.resourceType} ${r.resourceId})` : ''}
          </Text>
          {r.error ? <Text className="text-small text-danger">{r.error}</Text> : null}
          <Text className="text-small text-muted">{shortTime(r.createdAt)}</Text>
        </Row>
      ))}
    </Section>
  );
}

/** The platform's operators: add one by email, disable one (never yourself). */
function Operators({ self }: { self: string }) {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['platform', 'operators'], queryFn: api.platform.operators });
  const [email, setEmail] = useState('');
  const [capabilities, setCapabilities] = useState(SUPPORT);
  const [error, setError] = useState<string>();
  const done = () => client.invalidateQueries({ queryKey: ['platform', 'operators'] });
  const add = useMutation({
    mutationFn: () =>
      api.platform.addOperator({ email: email.trim(), capabilities: words(capabilities) }),
    onSuccess: () => {
      setEmail('');
      setError(undefined);
      done();
    },
    onError: (e) => setError(reasonOf(e)),
  });
  const toggle = useMutation({
    mutationFn: (o: Operator) => api.platform.updateOperator(o.id, { enabled: !!o.disabledAt }),
    onSuccess: done,
    onError: (e) => setError(reasonOf(e)),
  });
  return (
    <Section title="Operators">
      {(list.data ?? []).map((o) => (
        <Row key={o.id}>
          <View className="flex-1">
            <Text className="text-body text-text">
              {o.name} · {o.email}
            </Text>
            <Text className="text-small text-muted">{o.capabilities.join(', ')}</Text>
          </View>
          {o.disabledAt ? <Badge label="disabled" /> : null}
          {o.id === self ? (
            <Badge label="you" tone="primary" />
          ) : (
            <Button
              label={o.disabledAt ? 'Enable' : 'Disable'}
              tone={o.disabledAt ? 'secondary' : 'danger'}
              onPress={() => toggle.mutate(o)}
            />
          )}
        </Row>
      ))}
      <Row>
        <Field label="Email of the new operator" value={email} onChange={setEmail} />
        <Field label="Operator capabilities" value={capabilities} onChange={setCapabilities} />
        <Button
          label="Add operator"
          tone="primary"
          disabled={!email.trim() || !words(capabilities).length}
          busy={add.isPending}
          onPress={() => add.mutate()}
        />
      </Row>
      {error ? (
        <View className="px-4 py-2">
          <ErrorLine message={error} />
        </View>
      ) : null}
    </Section>
  );
}

/**
 * The platform's operator mode (B19): businesses, support access, usage, routed requests and
 * operators, each shown when the operator holds its capability (the server checks again).
 * "Work here" on an active support grant makes the back office send that business's id on every
 * call, until the operator stops.
 */
export function OperatorScreen() {
  const me = useQuery({ queryKey: ['platform', 'me'], queryFn: api.platform.me });
  const client = useQueryClient();
  const [asking, setAsking] = useState<PlatformTenant>();
  if (me.isPending) return <Empty title="Loading…" />;
  const operator = me.data?.operator;
  if (me.isError || !operator)
    return (
      <Empty title="This is for the platform's operators">
        {me.isError && !(me.error instanceof ApiError && me.error.status === 403)
          ? reasonOf(me.error)
          : 'Ask an operator to add you.'}
      </Empty>
    );
  const holds = (c: string) => operator.capabilities.includes(c);
  const workInGrant = (g: SupportGrant) => {
    workIn(g.tenantId);
    client.clear();
  };
  return (
    <ScrollView contentContainerClassName="gap-6 p-4">
      {holds(TENANTS) ? <Businesses onWork={(t) => setAsking(t)} /> : null}
      {holds(SUPPORT) ? <Support asking={asking} onWorkIn={workInGrant} /> : null}
      {holds(USAGE) ? <Usage /> : null}
      {holds(ROUTING) ? <Routing /> : null}
      {holds(OPERATORS) ? <Operators self={operator.id} /> : null}
    </ScrollView>
  );
}
