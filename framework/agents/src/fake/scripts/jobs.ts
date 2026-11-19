// Long-running jobs:
//   how is job <id>                    get-job (its status, progress and message, or its error)
//   which jobs are running             list-jobs { status: 'running' } (the person's own)
import { call, defineScript, say } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

// A refused call (another business's job: 404) is answered by the engine itself.
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

type Job = {
  status: string;
  progress: number | null;
  message: string | null;
  error: { message: string } | null;
  files: string[];
};

/** One job in a sentence. */
function jobLine(j: Job): string {
  switch (j.status) {
    case 'queued':
      return 'The job is waiting to start.';
    case 'running': {
      const done = j.progress === null ? '' : `: ${j.progress}% done`;
      return `The job is running${done}${j.message ? ` (${j.message})` : ''}.`;
    }
    case 'succeeded': {
      const n = j.files.length;
      return `The job is done${n ? `, with ${n} file${n === 1 ? '' : 's'}` : ''}.`;
    }
    case 'failed':
      return `The job failed: ${j.error?.message ?? 'no reason given'}`;
    default:
      return 'The job was cancelled.';
  }
}

export const jobsScripts = defineScriptSet({
  name: 'jobs',
  order: 310,
  scripts: [
    defineScript({
      name: 'job-status',
      match: (text) => new RegExp(`^how is job ${UUID}\\??$`, 'i').exec(text.trim())?.[1],
      step: (id, turn) => {
        const r = turn.result('get-job');
        if (!r) return [call('get-job', { id })];
        return [say(jobLine(r.result as Job))];
      },
    }),
    defineScript({
      name: 'jobs-running',
      match: (text) => (/^which jobs are running\??$/i.test(text.trim()) ? true : undefined),
      step: (_m, turn) => {
        const r = turn.result('list-jobs');
        if (!r) return [call('list-jobs', { status: 'running' })];
        const { items } = r.result as { items: Job[] };
        if (!items.length) return [say('No jobs are running.')];
        return [say(`${items.length} job${items.length === 1 ? ' is' : 's are'} running.`)];
      },
    }),
  ],
});
