import {
  type ImportOptionsInput,
  ImportsCapability,
  type JobInfo,
  type WriteResult,
} from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { PickedFile } from '../files/hooks';

/** The type an import file is sent as, from its name: a phone may say text/comma-separated-values. */
export function importMime(file: Pick<PickedFile, 'name' | 'mime'>): string {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.ndjson') || name.endsWith('.jsonl')) return 'application/x-ndjson';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.tsv') || name.endsWith('.txt')) return 'text/plain';
  return file.mime;
}

/** May the signed-in person import records (`imports.run`)? False until it loads. */
export function useCanImport(): boolean {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 5 * 60_000 }).data;
  return !!me?.capabilities.includes(ImportsCapability.name);
}

/**
 * Import a picked file: upload it for an import, then start one (`POST /api/imports`). The
 * answer is the write's: `done` with the job to follow, or `needs_approval`.
 */
export function useStartImport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (a: {
      file: PickedFile;
      options: Omit<ImportOptionsInput, 'file'>;
    }): Promise<WriteResult<JobInfo>> => {
      const uploaded = await api.imports.upload(a.file.body, {
        name: a.file.name,
        mime: importMime(a.file),
      });
      return api.imports.start({ ...a.options, file: uploaded.id });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['jobs'] }),
  });
}
