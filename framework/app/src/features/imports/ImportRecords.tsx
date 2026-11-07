import {
  IMPORT_MIME_TYPES,
  type ImportOptionsInput,
  ImportResult,
  isJobFinished,
} from '@hykr/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { errorMessage } from '../../framework/hooks';
import { getCatalog } from '../../runtime';
import { space, styles } from '../../theme';
import { pickDocuments } from '../files/pick';
import { useJob } from '../jobs/hooks';
import { JobProgress } from '../jobs/JobProgress';
import { useCanImport, useStartImport } from './hooks';

type Props = {
  /** The entity's name ('todo'). */
  entity: string;
  /** How the import reads the file: its key column, source, column mapping, references. */
  options?: Omit<ImportOptionsInput, 'entity' | 'file' | 'dryRun'>;
  /** What the records are called, for people ("to-dos"). Default: the entity's plural. */
  label?: string;
};

/** What the file picker offers: the types an import reads, and what phones call a CSV file. */
const PICK = [...IMPORT_MIME_TYPES, 'text/comma-separated-values', 'text/*'];

/** What an import did, in one line. */
export function importLine(r: ImportResult): string {
  const did = [
    `${r.created} ${r.dryRun ? 'to create' : 'created'}`,
    `${r.updated} ${r.dryRun ? 'to update' : 'updated'}`,
    r.unchanged ? `${r.unchanged} unchanged` : '',
    r.skipped ? `${r.skipped} skipped` : '',
    r.failed ? `${r.failed} not ${r.dryRun ? 'importable' : 'imported'}` : '',
  ].filter(Boolean);
  return `${r.rows} rows: ${did.join(', ')}${r.reportTruncated ? ` (the report lists the first ${r.reportRows})` : ''}`;
}

/**
 * Import records from a CSV, JSON or NDJSON file (people with `imports.run`; nothing for anyone
 * else): check a file first (a dry run writes nothing), then import it. Shows the job's progress,
 * what it did and its error report (the rows it could not write, to fix and import again). An
 * import that waits for an approval says so.
 */
export function ImportRecords({ entity, options, label }: Props) {
  const allowed = useCanImport();
  const start = useStartImport();
  const client = useQueryClient();
  const [jobId, setJobId] = useState<string | undefined>();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJob(jobId).data;
  const spec = Object.values(getCatalog().entities).find((s) => s.name === entity);
  const plural = spec?.plural;
  const what = label ?? plural ?? entity;
  const finished = job ? isJobFinished(job.status) : false;
  const result = job?.status === 'succeeded' ? ImportResult.safeParse(job.output) : undefined;

  // Once a real import is done, the lists show what it wrote.
  useEffect(() => {
    if (finished && plural && result?.success && !result.data.dryRun)
      void client.invalidateQueries({ queryKey: [plural] });
  }, [finished, plural, result?.success, result?.data?.dryRun, client]);

  if (!allowed || !spec) return null;

  const run = async (dryRun: boolean) => {
    setError(null);
    setNote(null);
    try {
      const [file] = await pickDocuments({ types: PICK });
      if (!file) return;
      const out = await start.mutateAsync({
        file,
        options: { ...options, entity, dryRun },
      });
      if (out.status === 'needs_approval') {
        setJobId(undefined);
        setNote(`The import waits for approval: ${out.approval.reason}`);
      } else setJobId(out.value.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const busy = start.isPending || (!!job && !finished);
  return (
    <View style={[styles.card, { gap: space.md }]}>
      <Text style={styles.heading}>Import {what}</Text>
      <Text style={styles.muted}>
        A CSV file with a header row, or JSON. Each row needs its id from the old system, so
        importing the same file again updates what it imported instead of adding it twice.
      </Text>
      <View style={[styles.row, { flexWrap: 'wrap' }]}>
        <Button
          title="Check a file"
          icon="search"
          variant="secondary"
          busy={busy}
          onPress={() => run(true)}
        />
        <Button title="Import a file" icon="upload" busy={busy} onPress={() => run(false)} />
      </View>
      {job ? <JobProgress job={job} label={result?.data?.dryRun ? 'Check' : 'Import'} /> : null}
      {result?.success ? <Text style={styles.text}>{importLine(result.data)}</Text> : null}
      {note ? <Text style={styles.muted}>{note}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}
