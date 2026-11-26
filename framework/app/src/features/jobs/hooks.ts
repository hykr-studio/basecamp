import { isJobFinished, type JobInfo, type ListJobsQuery } from '@hykr/contracts';
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';

/** How often an unfinished job is asked about. */
const EVERY_MS = 2_000;

/** One job, refreshed every two seconds until it finishes. */
export function useJob(id: string | undefined): UseQueryResult<JobInfo> {
  return useQuery({
    queryKey: ['jobs', 'one', id],
    queryFn: () => api.jobs.get(id as string),
    enabled: !!id,
    refetchInterval: (q) => {
      const job = q.state.data as JobInfo | undefined;
      return job && isJobFinished(job.status) ? false : EVERY_MS;
    },
  });
}

/**
 * A record's jobs (`{ entity, id }`), or the person's own. Refreshed every two seconds while one
 * of them has not finished.
 */
export function useJobs(q: ListJobsQuery = {}): UseQueryResult<JobInfo[]> {
  return useQuery({
    queryKey: ['jobs', 'list', q],
    queryFn: () => api.jobs.list(q),
    refetchInterval: (query) => {
      const items = query.state.data as JobInfo[] | undefined;
      return items?.some((j) => !isJobFinished(j.status)) ? EVERY_MS : false;
    },
  });
}

/** Stop a job that has not finished. */
export function useCancelJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.jobs.cancel(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['jobs'] }),
  });
}
