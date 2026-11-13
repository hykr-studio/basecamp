// The business's settings sections (H2) for the people who may change them: the time zone and
// quiet hours (`general`), approvals, money, business hours, SLAs and every other section that
// opts in, each edited as JSON (a power user's desk, as agents' triggers are) and saved as a merge
// patch of what changed, so a key taken out goes back to its default.
import { type EditableSettingsKey, patchBetween, type SettingsSectionView } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { api, reasonOf } from '../api';
import { Badge, Button, ErrorLine } from '../components/ui';

/** What the framework's sections are called here; a module's own shows its key. */
const TITLES: Record<string, string> = {
  general: 'General: time zone, quiet hours, reply time, marketing',
  approvals: 'Approvals: levels, thresholds, who approves',
  money: 'Money: currency, financial year, amounts',
  businessHours: 'Business hours and holidays',
  sla: 'SLA durations',
  memory: "The assistant's memory",
  shares: 'Share links',
  files: 'Files',
  parties: 'People who write in',
  members: 'Invitations: how long they last',
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function SectionEditor({ section }: { section: SettingsSectionView }) {
  const qc = useQueryClient();
  const before = isObject(section.value) ? section.value : {};
  const [text, setText] = useState(JSON.stringify(before, null, 2));
  const [note, setNote] = useState<string>();
  const save = useMutation({
    mutationFn: async () => {
      let after: unknown;
      try {
        after = JSON.parse(text);
      } catch {
        throw new Error('This is not JSON');
      }
      if (!isObject(after)) throw new Error('Give an object: { … }');
      const patch = patchBetween(before, after);
      if (!Object.keys(patch).length) throw new Error('Nothing changed');
      return api.settings.updateSection(section.key as EditableSettingsKey, patch as never);
    },
    onSuccess: (res) => {
      setNote(res.status === 'needs_approval' ? 'Waiting for approval' : undefined);
      qc.invalidateQueries({ queryKey: ['settings-sections'] });
    },
  });
  return (
    <View className="gap-2 border-b border-divider py-3">
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-body font-heading text-text">
          {TITLES[section.key] ?? section.key}
        </Text>
        {section.problems.length ? <Badge label="needs fixing" tone="warn" /> : null}
      </View>
      {section.problems.map((p) => (
        <Text key={p} className="text-small text-danger">
          {p}
        </Text>
      ))}
      <TextInput
        accessibilityLabel={`${section.key} settings`}
        value={text}
        onChangeText={setText}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-24 rounded-control border border-border bg-card px-3 py-2 text-small text-text"
      />
      {note ? <Text className="text-small text-muted">{note}</Text> : null}
      <ErrorLine message={save.isError ? reasonOf(save.error) : undefined} />
      <Button
        label="Save"
        tone="primary"
        busy={save.isPending}
        disabled={text === JSON.stringify(before, null, 2)}
        onPress={() => save.mutate()}
      />
    </View>
  );
}

/** Every section this person may change; nothing when there is none. */
export function SettingsSections() {
  const sections = useQuery({ queryKey: ['settings-sections'], queryFn: api.settings.sections });
  if (!sections.data?.length) return null;
  return (
    <View className="w-full max-w-3xl gap-3 self-center rounded-card border border-border bg-card p-4">
      <View className="gap-0.5">
        <Text className="text-heading font-heading text-text">Business settings</Text>
        <Text className="text-small text-muted">
          How your business works: its hours, approvals, money and more. Take a key out to go back
          to its default.
        </Text>
      </View>
      {sections.data.map((s) => (
        <SectionEditor key={`${s.key}:${JSON.stringify(s.value)}`} section={s} />
      ))}
    </View>
  );
}
