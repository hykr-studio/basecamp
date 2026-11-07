import { ApiError } from '@hykr/api-client';
import {
  AddDomainSpec,
  type CustomField,
  CustomFieldSpec,
  RemoveDomainSpec,
  SetFeatureSpec,
  SettingsCapability,
  UpdateBrandingSpec,
  VerifyDomainSpec,
} from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { api, reasonOf } from '../api';
import { Badge, Button, Empty, ErrorLine } from '../components/ui';

const INPUT = 'min-h-9 rounded-control border border-border bg-card px-3 text-body text-text';

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <View className="w-full max-w-3xl gap-3 self-center rounded-card border border-border bg-card p-4">
      <View className="gap-0.5">
        <Text className="text-heading font-heading text-text">{title}</Text>
        <Text className="text-small text-muted">{hint}</Text>
      </View>
      {children}
    </View>
  );
}

/** A write's refusal or error, for a person. */
const failure = (e: unknown) =>
  e instanceof ApiError && e.status === 403 ? reasonOf(e) || 'Not allowed' : reasonOf(e);

function Branding({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });
  const [draft, setDraft] = useState<{ name?: string; logoUrl?: string; primary?: string }>({});
  const save = useMutation({
    mutationFn: () =>
      api.command(UpdateBrandingSpec, {
        ...(draft.name !== undefined ? { name: draft.name.trim() || null } : {}),
        ...(draft.logoUrl !== undefined ? { logoUrl: draft.logoUrl.trim() || null } : {}),
        ...(draft.primary !== undefined
          ? { colors: { primary: draft.primary.trim() || null } }
          : {}),
      }),
    onSuccess: () => {
      setDraft({});
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const b = settings.data?.branding;
  return (
    <Section
      title="Branding"
      hint="The name, logo and colour your team and customers see in the app."
    >
      <TextInput
        accessibilityLabel="Name"
        placeholder="Name, e.g. Acme"
        editable={canManage}
        defaultValue={b?.name ?? ''}
        onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
        className={INPUT}
      />
      <TextInput
        accessibilityLabel="Logo address"
        placeholder="Logo, e.g. https://cdn.example.com/logo.png"
        editable={canManage}
        autoCapitalize="none"
        defaultValue={b?.logoUrl ?? ''}
        onChangeText={(logoUrl) => setDraft((d) => ({ ...d, logoUrl }))}
        className={INPUT}
      />
      <TextInput
        accessibilityLabel="Main colour"
        placeholder="Main colour, e.g. #1f6feb"
        editable={canManage}
        autoCapitalize="none"
        defaultValue={b?.colors.primary ?? ''}
        onChangeText={(primary) => setDraft((d) => ({ ...d, primary }))}
        className={INPUT}
      />
      <ErrorLine message={save.isError ? failure(save.error) : undefined} />
      {canManage ? (
        <Button
          label="Save branding"
          tone="primary"
          busy={save.isPending}
          disabled={!Object.keys(draft).length}
          onPress={() => save.mutate()}
        />
      ) : null}
    </Section>
  );
}

function Features({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const features = useQuery({ queryKey: ['features'], queryFn: api.settings.features });
  const set = useMutation({
    mutationFn: (v: { key: string; on: boolean }) => api.command(SetFeatureSpec, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['features'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  return (
    <Section
      title="Features"
      hint="What is switched on for your business. Some only the platform switches."
    >
      {features.data?.length === 0 ? (
        <Text className="text-small text-muted">No features to switch.</Text>
      ) : null}
      {features.data?.map((f) => (
        <View key={f.key} className="flex-row items-center gap-3 border-b border-divider py-2">
          <View className="flex-1 gap-0.5">
            <Text className="text-body font-heading text-text">{f.label.en ?? f.key}</Text>
            <Text className="text-small text-muted">{f.description?.en ?? f.key}</Text>
          </View>
          {f.managedBy === 'platform' ? <Badge label="by the platform" /> : null}
          <Switch
            accessibilityLabel={f.label.en ?? f.key}
            value={f.on}
            disabled={!canManage || f.managedBy !== 'tenant' || set.isPending}
            onValueChange={(on) => set.mutate({ key: f.key, on })}
          />
        </View>
      ))}
      <ErrorLine message={set.isError ? failure(set.error) : undefined} />
    </Section>
  );
}

const TYPES = ['text', 'number', 'boolean', 'date', 'select'] as const;

function CustomFields({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const fields = useQuery({
    queryKey: ['custom-fields'],
    queryFn: () => api.entity(CustomFieldSpec).list({ limit: 200 }),
  });
  const [draft, setDraft] = useState({ entity: '', key: '', label: '', type: 'text', options: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['custom-fields'] });
  const add = useMutation({
    mutationFn: () =>
      api.entity(CustomFieldSpec).create({
        entity: draft.entity.trim(),
        key: draft.key.trim(),
        type: draft.type,
        label: { en: draft.label.trim() },
        ...(draft.type === 'select'
          ? {
              options: draft.options
                .split(',')
                .map((o) => o.trim())
                .filter(Boolean),
            }
          : {}),
      }),
    onSuccess: () => {
      setDraft({ entity: draft.entity, key: '', label: '', type: 'text', options: '' });
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.entity(CustomFieldSpec).remove(id),
    onSuccess: refresh,
  });
  const items = (fields.data?.items ?? []) as CustomField[];
  return (
    <Section title="Custom fields" hint="Your own fields on records, such as a priority on to-dos.">
      {items.map((f) => (
        <View key={f.id} className="flex-row items-center gap-3 border-b border-divider py-2">
          <View className="flex-1 gap-0.5">
            <Text className="text-body font-heading text-text">
              {f.label.en}{' '}
              <Text className="text-small text-muted">
                ({f.entity}.{f.key})
              </Text>
            </Text>
            <Text className="text-small text-muted">
              {f.type}
              {f.options.length ? `: ${f.options.join(', ')}` : ''}
              {f.required ? ' · required' : ''}
            </Text>
          </View>
          {canManage ? (
            <Button label="Remove" tone="danger" onPress={() => remove.mutate(f.id)} />
          ) : null}
        </View>
      ))}
      {canManage ? (
        <View className="gap-2">
          <View className="flex-row flex-wrap gap-2">
            {(['entity', 'key', 'label'] as const).map((k) => (
              <TextInput
                key={k}
                accessibilityLabel={k}
                placeholder={
                  {
                    entity: 'Record, e.g. todo',
                    key: 'Key, e.g. priority',
                    label: 'Label, e.g. Priority',
                  }[k]
                }
                autoCapitalize="none"
                value={draft[k]}
                onChangeText={(v) => setDraft((d) => ({ ...d, [k]: v }))}
                className={`${INPUT} min-w-40 flex-1`}
              />
            ))}
          </View>
          <View className="flex-row flex-wrap items-center gap-2">
            {TYPES.map((t) => (
              <Button
                key={t}
                label={t}
                tone={draft.type === t ? 'primary' : 'secondary'}
                onPress={() => setDraft((d) => ({ ...d, type: t }))}
              />
            ))}
          </View>
          {draft.type === 'select' ? (
            <TextInput
              accessibilityLabel="Options"
              placeholder="Options, comma-separated: low, medium, high"
              value={draft.options}
              onChangeText={(options) => setDraft((d) => ({ ...d, options }))}
              className={INPUT}
            />
          ) : null}
          <ErrorLine
            message={
              add.isError ? failure(add.error) : remove.isError ? failure(remove.error) : undefined
            }
          />
          <Button
            label="Add field"
            tone="primary"
            busy={add.isPending}
            onPress={() => add.mutate()}
          />
        </View>
      ) : null}
    </Section>
  );
}

function Domains() {
  const qc = useQueryClient();
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.settings.domains });
  const [origin, setOrigin] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['domains'] });
  const add = useMutation({
    mutationFn: () => api.command(AddDomainSpec, { origin: origin.trim() }),
    onSuccess: () => {
      setOrigin('');
      refresh();
    },
  });
  const verify = useMutation({
    mutationFn: (domainId: string) => api.command(VerifyDomainSpec, { domainId }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (domainId: string) => api.command(RemoveDomainSpec, { domainId }),
    onSuccess: refresh,
  });
  const error = [add, verify, remove].find((m) => m.isError)?.error;
  return (
    <Section
      title="Web addresses"
      hint="Serve the app on your own address. Publish the TXT record, then verify it."
    >
      {domains.data?.map((d) => (
        <View key={d.id} className="gap-1 border-b border-divider py-2">
          <View className="flex-row items-center gap-3">
            <Text className="flex-1 text-body font-heading text-text">{d.origin}</Text>
            <Badge
              label={d.verified ? 'verified' : 'waiting'}
              tone={d.verified ? 'success' : 'warn'}
            />
            {d.verified ? null : (
              <Button label="Verify" busy={verify.isPending} onPress={() => verify.mutate(d.id)} />
            )}
            <Button label="Remove" tone="danger" onPress={() => remove.mutate(d.id)} />
          </View>
          {d.verified ? null : (
            <Text selectable className="text-small text-muted">
              TXT {d.record.name} = {d.record.value}
            </Text>
          )}
        </View>
      ))}
      <View className="flex-row gap-2">
        <TextInput
          accessibilityLabel="Address"
          placeholder="https://app.example.com"
          autoCapitalize="none"
          value={origin}
          onChangeText={setOrigin}
          className={`${INPUT} flex-1`}
        />
        <Button label="Add" tone="primary" busy={add.isPending} onPress={() => add.mutate()} />
      </View>
      <ErrorLine message={error ? failure(error) : undefined} />
    </Section>
  );
}

/** The business's setup: branding, features, custom fields and web addresses. */
export function SettingsScreen() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  if (me.isPending) return <Empty title="Loading…" />;
  if (me.isError) return <Empty title="Can't load settings">{reasonOf(me.error)}</Empty>;
  const canManage = me.data.capabilities.includes(SettingsCapability.name);
  return (
    <ScrollView contentContainerClassName="gap-4 p-4">
      <Branding canManage={canManage} />
      <Features canManage={canManage} />
      <CustomFields canManage={canManage} />
      {canManage ? <Domains /> : null}
    </ScrollView>
  );
}
