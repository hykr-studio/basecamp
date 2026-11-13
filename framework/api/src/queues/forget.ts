// Forgetting a person in Redis (decisions V8): BullMQ keeps each queue's finished jobs for a
// while (`jobDefaults`), and each one holds its whole data (an event's envelope, row and before
// included, a notification's row) and its failure. When a person is erased, every finished job
// that names them or one of the records erased with them is removed, and so are the entries of
// the queues' event streams that do. Jobs still waiting or running are left to finish: they are
// the work in flight, and once finished they go within the keep bound. Nothing here loads Nest.
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { type Jobs, queues } from '../hooks.js';

/** Whom to forget: ids, matched whole (case kept), and emails or numbers, matched anywhere. */
export interface Forget {
  ids: readonly string[];
  texts: readonly string[];
}

/** The finished jobs' sets, and how many of a set's jobs one script reads. */
const FINISHED = ['completed', 'failed'] as const;
const PAGE = 500;

/**
 * The jobs among one page of a finished set whose data, return value or failure holds one of
 * the ids (a whole word of letters, digits, `-` and `_`) or one of the texts (lower case). Run in
 * Redis, so only the matching ids come back. KEYS[1]: the set. ARGV: the job key's prefix, the
 * page's first and last rank, how many ids follow, the ids, then the texts.
 */
const MATCHING = `
local jobs = redis.call('ZRANGE', KEYS[1], ARGV[2], ARGV[3])
local n = tonumber(ARGV[4])
local exact = {}
for i = 5, 4 + n do exact[ARGV[i]] = true end
local out = {}
for _, job in ipairs(jobs) do
  local fields = redis.call('HMGET', ARGV[1] .. job, 'data', 'returnvalue', 'failedReason', 'stacktrace')
  local text = ''
  for _, f in ipairs(fields) do
    if f then text = text .. '\\n' .. f end
  end
  local hit = false
  if n > 0 then
    for word in string.gmatch(text, '[%w_%-]+') do
      if exact[word] then
        hit = true
        break
      end
    end
  end
  if not hit and #ARGV > 4 + n then
    local low = string.lower(text)
    for i = 5 + n, #ARGV do
      if string.find(low, ARGV[i], 1, true) then
        hit = true
        break
      end
    end
  end
  if hit then table.insert(out, job) end
end
return out
`;

/** Does this text hold one of the ids (whole words) or texts? */
function holds(text: string, ids: ReadonlySet<string>, texts: readonly string[]): boolean {
  for (const word of text.match(/[A-Za-z0-9_-]+/g) ?? []) if (ids.has(word)) return true;
  const low = text.toLowerCase();
  return texts.some((t) => low.includes(t));
}

/** One queue's finished jobs and stream entries that hold the person, removed. */
async function forgetIn(redis: Redis, queue: Queue, who: Forget): Promise<number> {
  let removed = 0;
  for (const state of FINISHED) {
    const key = queue.toKey(state);
    // From the end: removing a job shifts the ranks of those after it.
    const total = await redis.zcard(key);
    for (let stop = total - 1; stop >= 0; stop -= PAGE) {
      const start = Math.max(0, stop - PAGE + 1);
      const found = (await redis.eval(
        MATCHING,
        1,
        key,
        queue.toKey(''),
        start,
        stop,
        who.ids.length,
        ...who.ids,
        ...who.texts,
      )) as string[];
      for (const id of found) removed += await queue.remove(id);
    }
  }
  // The queue's event stream: a job's id names its event, a failure's reason may name them.
  const stream = queue.toKey('events');
  const ids = new Set(who.ids);
  let from = '-';
  for (;;) {
    const page = (await redis.xrange(stream, from, '+', 'COUNT', 1000)) as [string, string[]][];
    const naming = page.filter(([, f]) => holds(f.join('\n'), ids, who.texts)).map(([id]) => id);
    if (naming.length) await redis.xdel(stream, ...naming);
    if (page.length < 1000) break;
    from = `(${page[page.length - 1][0]}`;
  }
  return removed;
}

/**
 * Remove every finished job, in every registered queue, that holds the person (their ids,
 * emails and numbers, and the ids of the records erased with them), and the stream entries
 * that do. Returns how many jobs went.
 */
export async function forgetJobs(
  jobs: Pick<Jobs, 'queue'>,
  redisUrl: string,
  who: Forget,
): Promise<number> {
  const forget: Forget = {
    ids: [...new Set(who.ids.filter((id) => id.length >= 8))],
    texts: [...new Set(who.texts.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 6))],
  };
  if (!forget.ids.length && !forget.texts.length) return 0;
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  try {
    let removed = 0;
    for (const def of queues.all()) removed += await forgetIn(redis, jobs.queue(def.name), forget);
    return removed;
  } finally {
    redis.disconnect();
  }
}
