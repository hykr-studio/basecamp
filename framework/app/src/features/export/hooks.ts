import {
  DATA_EXPORT_JOB,
  DataExportCapability,
  type JobInfo,
  type StartExportInput,
  StartExportSpec,
} from '@hykr/contracts';
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useJobs } from '../jobs/hooks';

/** May the signed-in person export the business's data (`data.export`)? */
export function useCanExport(): boolean {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 60_000 });
  return me.data?.capabilities.includes(DataExportCapability.name) ?? false;
}

/** The person's exports, newest first, refreshed while one runs. */
export function useExports(): UseQueryResult<JobInfo[]> {
  return useJobs({ kind: DATA_EXPORT_JOB });
}

/** Start an export (`POST /api/exports`); the export's job is the result. */
export function useStartExport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: StartExportInput = {}) => api.command(StartExportSpec, input),
    onSuccess: () => client.invalidateQueries({ queryKey: ['jobs'] }),
  });
}
