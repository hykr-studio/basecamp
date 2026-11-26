import {
  DATA_EXPORT_JOB,
  type ExportOutput,
  isJobFinished,
  type JobInfo,
  StartExportSpec,
} from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { api, reasonOf } from '../api';
import { Badge, Button, ErrorLine } from '../components/ui';
import { ago } from '../time';

const STATUS: Record<
  JobInfo['status'],
  { label: string; tone: 'neutral' | 'warn' | 'danger' | 'success' }
> = {
  queued: { label: 'waiting', tone: 'neutral' },
  running: { label: 'running', tone: 'warn' },
  succeeded: { label: 'ready', tone: 'success' },
  failed: { label: 'failed', tone: 'danger' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
};

/** One export: when, how far, how many records, and its archive to download. */
function ExportRow({ job }: { job: JobInfo }) {
  const [error, setError] = useState<string>();
  const download = useMutation({
    // A fresh, short-lived URL each time.
    mutationFn: async (fileId: string) => {
      const file = await api.files.get(fileId);
      if (!file.url) throw new Error('The archive has no download address');
      await Linking.openURL(file.url);
    },
    onError: (e) => setError(reasonOf(e)),
  });
  const status = STATUS[job.status];
  const rows = (job.output as ExportOutput | null)?.rows;
  return (
    <View className="gap-1 border-b border-divider py-2">
      <View className="flex-row items-center gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-body font-heading text-text">Export, {ago(job.createdAt)}</Text>
          <Text className="text-small text-muted">
            {job.error?.message ??
              (rows !== undefined
                ? `${rows} records`
                : `${job.progress ?? 0}%${job.message ? ` · ${job.message}` : ''}`)}
          </Text>
        </View>
        <Badge label={status.label} tone={status.tone} />
        {job.files.map((id) => (
          <Button
            key={id}
            label="Download"
            busy={download.isPending}
            onPress={() => download.mutate(id)}
          />
        ))}
      </View>
      <ErrorLine message={error} />
    </View>
  );
}

/**
 * Export the business's data (people with `data.export`): start an export, follow it, download
 * its zip archive of JSON and CSV files. The API reads every record as the person, so the
 * archive holds what they can see.
 */
export function DataExport() {
  const qc = useQueryClient();
  const exports = useQuery({
    queryKey: ['exports'],
    queryFn: () => api.jobs.list({ kind: DATA_EXPORT_JOB, limit: 10 }),
    refetchInterval: (q) =>
      (q.state.data as JobInfo[] | undefined)?.some((j) => !isJobFinished(j.status))
        ? 2_000
        : false,
  });
  const start = useMutation({
    mutationFn: () => api.command(StartExportSpec, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exports'] }),
  });
  const items = exports.data ?? [];
  const running = items.some((j) => !isJobFinished(j.status));
  return (
    <View className="w-full max-w-3xl gap-3 self-center rounded-card border border-border bg-card p-4">
      <View className="gap-0.5">
        <Text className="text-heading font-heading text-text">Data export</Text>
        <Text className="text-small text-muted">
          Download the business's records you can see, as JSON and CSV files in one zip archive.
          Fields hidden from you stay hidden.
        </Text>
      </View>
      {items.length === 0 && !exports.isPending ? (
        <Text className="text-small text-muted">No exports yet.</Text>
      ) : null}
      {items.map((job) => (
        <ExportRow key={job.id} job={job} />
      ))}
      <ErrorLine
        message={
          start.isError
            ? reasonOf(start.error)
            : exports.isError
              ? reasonOf(exports.error)
              : undefined
        }
      />
      <Button
        label="Start export"
        tone="primary"
        busy={start.isPending}
        disabled={running}
        onPress={() => start.mutate()}
      />
    </View>
  );
}
