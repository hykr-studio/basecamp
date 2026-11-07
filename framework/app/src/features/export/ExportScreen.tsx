import { type ExportFormat, type ExportOutput, isJobFinished, type JobInfo } from '@hykr/contracts';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { ScreenTitle, SectionHeading } from '../../components/ScreenTitle';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Checkbox } from '../../components/ui/checkbox';
import { Text } from '../../components/ui/text';
import { useScreenContext } from '../../framework/assistant-context';
import { when } from '../../framework/dates';
import { LoadError } from '../../framework/EmptyState';
import { errorMessage } from '../../framework/hooks';
import { Loading } from '../../framework/Loading';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { styles } from '../../theme';
import { JobProgress } from '../jobs/JobProgress';
import { useExports, useStartExport } from './hooks';

const FORMATS: readonly { format: ExportFormat; label: string }[] = [
  { format: 'json', label: 'JSON' },
  { format: 'csv', label: 'CSV' },
];

/** How many records a finished export holds, when it says. */
const rowsOf = (job: JobInfo) => (job.output as ExportOutput | null)?.rows;

function Start({ running }: { running: boolean }) {
  const { t } = useT();
  const toast = useToast();
  const [formats, setFormats] = useState<ExportFormat[]>(['json', 'csv']);
  const start = useStartExport();
  const toggle = (f: ExportFormat) =>
    setFormats((now) => (now.includes(f) ? now.filter((x) => x !== f) : [...now, f]));
  return (
    <Card>
      <Text variant="muted">{t('export.hint')}</Text>
      <Text className="font-semibold">{t('export.formats')}</Text>
      <View className="flex-row flex-wrap gap-4">
        {FORMATS.map(({ format, label }) => (
          <View key={format} className="flex-row items-center gap-2">
            <Checkbox
              checked={formats.includes(format)}
              onCheckedChange={() => toggle(format)}
              accessibilityLabel={label}
            />
            <Text>{label}</Text>
          </View>
        ))}
      </View>
      <Button
        disabled={!formats.length || running || start.isPending}
        accessibilityLabel={t('export.start')}
        onPress={() =>
          start.mutate(
            { formats },
            {
              onSuccess: () => toast.show({ message: t('export.started'), tone: 'success' }),
              onError: (e) => toast.show({ message: errorMessage(e), tone: 'error' }),
            },
          )
        }
      >
        <Text>{t('export.start')}</Text>
      </Button>
    </Card>
  );
}

/**
 * Export the business's data: pick the formats, start an export, and download the archive once
 * it is ready. Shown to people whose roles hold `data.export` (`exportPlugin`); the API reads
 * every record as them, so the archive holds what they can see.
 */
export function ExportScreen() {
  useScreenContext({ screen: 'export' });
  const { t } = useT();
  const exports = useExports();
  const items = exports.data ?? [];
  return (
    <ScrollView contentContainerStyle={[styles.content, { gap: 16 }]}>
      <ScreenTitle title={t('export.title')} />
      <Start running={items.some((j) => !isJobFinished(j.status))} />
      <SectionHeading>{t('export.yours')}</SectionHeading>
      {exports.error ? (
        <LoadError what="your exports" onRetry={() => exports.refetch()} />
      ) : exports.isPending ? (
        <Loading />
      ) : items.length ? (
        items.map((job) => {
          const rows = rowsOf(job);
          return (
            <Card key={job.id}>
              <JobProgress job={job} label={t('export.of', { date: when(job.createdAt) })} />
              {rows !== undefined ? (
                <Text variant="muted">{t('export.rows', { rows })}</Text>
              ) : null}
            </Card>
          );
        })
      ) : (
        <Text variant="muted">{t('export.none')}</Text>
      )}
    </ScrollView>
  );
}
