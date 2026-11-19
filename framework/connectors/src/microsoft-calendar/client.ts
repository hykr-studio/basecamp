// The parts of Microsoft Graph a calendar connection uses: busy times (getSchedule), our events
// (written with a deterministic key in an extended property, so a retry never makes two), what
// changed since the last look (a calendarView delta query), and change subscriptions. Only
// busy intervals and our own events' ids and times are returned: never a subject, a body or an
// attendee of the person's own events.
import { mergeBusy } from '../google-calendar/client.js';
import {
  MICROSOFT_ENDPOINTS,
  MicrosoftApiError,
  type MicrosoftEndpoints,
  type MicrosoftTransport,
  microsoftError,
} from './transport.js';

/** The extended property our events carry: its value is the record's key. */
export const BASECAMP_KEY_PROPERTY =
  'String {3b7c1a52-8f4e-4d1a-9c2b-6e5f0a9d7c41} Name basecampKey';

/** A key Graph can filter on safely: letters, digits, '-' and '_' only. */
export const MICROSOFT_KEY = /^[A-Za-z0-9_-]{5,200}$/;

/** A busy interval, as ISO date-times. */
export interface MicrosoftBusy {
  start: string;
  end: string;
}

/** An event we keep for a record. Times are instants; `timeZone` is the zone it is shown in. */
export interface MicrosoftEventInput {
  /** The record's deterministic key: found again by it. */
  key: string;
  /** Graph's id, when we know it. */
  id?: string;
  subject: string;
  body?: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  /** An IANA zone. */
  timeZone: string;
}

/** One change a delta query reported: ids and times only. */
export interface MicrosoftChange {
  id: string;
  /** Deleted, cancelled, or no longer in the delta's window. */
  removed: boolean;
  /** Where it is now (timed events only). */
  startsAt?: string;
  endsAt?: string;
}

export interface MicrosoftChanges {
  items: MicrosoftChange[];
  /** The deltaLink: where to look next time. */
  cursor: string;
  /** The old cursor no longer worked: `items` is the whole window, not changes. */
  reset: boolean;
}

export interface MicrosoftSubscription {
  id: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Graph keeps an event subscription at most 4230 minutes: ask for a little less. */
export const SUBSCRIPTION_MINUTES = 4200;
/** How far back and ahead a delta query looks, from when its first cursor is made. */
export const DELTA_BACK_DAYS = 1;
export const DELTA_AHEAD_DAYS = 365;
/** Most pages read while listing changes: a larger calendar is listed again next time. */
const MAX_PAGES = 40;
const DAY = 86_400_000;

export interface MicrosoftCalendarClient {
  /** Busy intervals of the person's own calendar between two times, merged. */
  getSchedule(a: { address: string; from: string; to: string }): Promise<MicrosoftBusy[]>;
  /** Put this event in the person's calendar: updated if it is there (by id or key), else made. */
  upsertEvent(event: MicrosoftEventInput): Promise<{ id: string }>;
  /** Take it out. Already gone is fine. */
  deleteEvent(id: string): Promise<void>;
  /** What changed since `cursor`; without one, every event in the window. */
  changes(cursor?: string | null): Promise<MicrosoftChanges>;
  /** Ask Graph to post to `notificationUrl` when the person's events change. */
  subscribe(a: { notificationUrl: string; clientState: string }): Promise<MicrosoftSubscription>;
  /** Delete a subscription. Already gone is fine. */
  unsubscribe(id: string): Promise<void>;
}

/** Graph's UTC wall time ('2026-11-20T10:00:00.0000000', zone UTC) as an ISO instant. */
export function instantOf(t: { dateTime?: string; timeZone?: string } | undefined): string | null {
  if (!t?.dateTime) return null;
  const zone = (t.timeZone ?? 'UTC').toUpperCase();
  let raw = t.dateTime.replace(/(\.\d{3})\d+/, '$1');
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    if (zone !== 'UTC' && zone !== 'ETC/UTC' && zone !== 'COORDINATED UNIVERSAL TIME') return null;
    raw += 'Z';
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** An instant as Graph's wall time in UTC: no offset, the zone said beside it. */
const utcWall = (iso: string) => new Date(iso).toISOString().replace(/Z$/, '');

/** An instant as the wall time in `timeZone` ('2026-11-20T15:30:00'). */
export function wallTimeIn(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/** A client for one person's calendar, with an access token. */
export function microsoftCalendarClient(
  transport: MicrosoftTransport,
  a: { accessToken: string; endpoints?: MicrosoftEndpoints; now?: () => number },
): MicrosoftCalendarClient {
  const graph = (a.endpoints ?? MICROSOFT_ENDPOINTS).graph;
  const now = a.now ?? Date.now;
  const headers = {
    authorization: `Bearer ${a.accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
    prefer: 'outlook.timezone="UTC"',
  };
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    pathOrUrl: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    transport({
      method,
      url:
        pathOrUrl.startsWith('https://') || pathOrUrl.startsWith('http://')
          ? pathOrUrl
          : `${graph}${pathOrUrl}`,
      headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const eventBody = (e: MicrosoftEventInput) => ({
    subject: e.subject,
    body: { contentType: 'text', content: e.body ?? '' },
    ...(e.location ? { location: { displayName: e.location } } : {}),
    start: { dateTime: wallTimeIn(e.startsAt, e.timeZone), timeZone: e.timeZone },
    end: { dateTime: wallTimeIn(e.endsAt, e.timeZone), timeZone: e.timeZone },
    showAs: 'busy',
    singleValueExtendedProperties: [{ id: BASECAMP_KEY_PROPERTY, value: e.key }],
  });

  /** Our event for a key, if it is in the calendar. */
  const findByKey = async (key: string): Promise<string | null> => {
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${BASECAMP_KEY_PROPERTY}' and ep/value eq '${key}')`;
    const q = new URLSearchParams({ $filter: filter, $select: 'id', $top: '2' });
    const res = await call('GET', `/me/events?${q}`);
    if (res.status !== 200) throw microsoftError(res.status, res.body, 'Looking for the event');
    const found = (res.body as { value?: { id: string }[] })?.value ?? [];
    return found[0]?.id ?? null;
  };

  return {
    async getSchedule({ address, from, to }) {
      const res = await call('POST', '/me/calendar/getSchedule', {
        schedules: [address],
        startTime: { dateTime: utcWall(from), timeZone: 'UTC' },
        endTime: { dateTime: utcWall(to), timeZone: 'UTC' },
        availabilityViewInterval: 15,
      });
      if (res.status !== 200) throw microsoftError(res.status, res.body, 'Reading busy times');
      const value =
        (
          res.body as {
            value?: {
              scheduleId?: string;
              error?: { message?: string; responseCode?: string };
              scheduleItems?: {
                status?: string;
                start?: { dateTime?: string; timeZone?: string };
                end?: { dateTime?: string; timeZone?: string };
              }[];
            }[];
          }
        )?.value ?? [];
      const busy: MicrosoftBusy[] = [];
      for (const s of value) {
        if (s.error)
          throw new MicrosoftApiError(
            200,
            s.error.responseCode,
            `Microsoft could not read the calendar: ${s.error.message ?? 'unknown'}`,
          );
        for (const item of s.scheduleItems ?? []) {
          // Free and working elsewhere leave the time open; busy, tentative and away do not.
          if (!['busy', 'tentative', 'oof'].includes(String(item.status).toLowerCase())) continue;
          const start = instantOf(item.start);
          const end = instantOf(item.end);
          if (start && end) busy.push({ start, end });
        }
      }
      return mergeBusy(busy);
    },

    async upsertEvent(event) {
      if (!MICROSOFT_KEY.test(event.key)) throw new Error(`"${event.key}" is not an event key`);
      const body = eventBody(event);
      const patch = async (id: string) => {
        const res = await call('PATCH', `/me/events/${encodeURIComponent(id)}`, body);
        if (res.status === 404) return null;
        if (res.status !== 200) throw microsoftError(res.status, res.body, 'Saving the event');
        return { id: (res.body as { id?: string })?.id ?? id };
      };
      if (event.id) {
        const done = await patch(event.id);
        if (done) return done;
      }
      // Not known, or gone: a try before may have made it and lost the answer. Look by key.
      const found = await findByKey(event.key);
      if (found) {
        const done = await patch(found);
        if (done) return done;
      }
      const res = await call('POST', '/me/events', body);
      if (res.status !== 201 && res.status !== 200)
        throw microsoftError(res.status, res.body, 'Saving the event');
      const id = (res.body as { id?: string })?.id;
      if (!id) throw new MicrosoftApiError(res.status, 'no_id', 'Microsoft returned no event id');
      return { id };
    },

    async deleteEvent(id) {
      const res = await call('DELETE', `/me/events/${encodeURIComponent(id)}`);
      if (res.status === 204 || res.status === 200 || res.status === 404 || res.status === 410)
        return;
      throw microsoftError(res.status, res.body, 'Deleting the event');
    },

    async changes(cursor) {
      const first = () => {
        const q = new URLSearchParams({
          startDateTime: new Date(now() - DELTA_BACK_DAYS * DAY).toISOString(),
          endDateTime: new Date(now() + DELTA_AHEAD_DAYS * DAY).toISOString(),
        });
        return `/me/calendarView/delta?${q}`;
      };
      const list = async (start: string, resuming: boolean) => {
        const items: MicrosoftChange[] = [];
        let next = start;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await call('GET', next, undefined, {
            prefer: `${headers.prefer}, odata.maxpagesize=200`,
          });
          if (resuming && res.status === 410) return null;
          if (res.status !== 200) {
            const err = microsoftError(res.status, res.body, 'Listing changes');
            if (
              resuming &&
              (err.code === 'syncStateNotFound' ||
                err.code === 'resyncRequired' ||
                err.code === 'SyncStateNotFound')
            )
              return null;
            throw err;
          }
          const body = res.body as {
            value?: {
              id: string;
              '@removed'?: unknown;
              isCancelled?: boolean;
              isAllDay?: boolean;
              start?: { dateTime?: string; timeZone?: string };
              end?: { dateTime?: string; timeZone?: string };
            }[];
            '@odata.nextLink'?: string;
            '@odata.deltaLink'?: string;
          };
          for (const v of body.value ?? []) {
            if (!v?.id) continue;
            if (v['@removed'] || v.isCancelled) {
              items.push({ id: v.id, removed: true });
              continue;
            }
            const startsAt = v.isAllDay ? null : instantOf(v.start);
            const endsAt = v.isAllDay ? null : instantOf(v.end);
            items.push({
              id: v.id,
              removed: false,
              ...(startsAt && endsAt ? { startsAt, endsAt } : {}),
            });
          }
          if (body['@odata.deltaLink']) return { items, cursor: body['@odata.deltaLink'] };
          if (!body['@odata.nextLink']) break;
          next = body['@odata.nextLink'];
        }
        throw new MicrosoftApiError(
          0,
          'too_many_pages',
          'The calendar has too many changes to list',
        );
      };
      if (cursor) {
        const changed = await list(cursor, true);
        if (changed) return { ...changed, reset: false };
      }
      const all = await list(first(), false);
      if (!all) throw new MicrosoftApiError(410, 'gone', 'Microsoft refused a full listing');
      return { ...all, reset: !!cursor };
    },

    async subscribe({ notificationUrl, clientState }) {
      const res = await call('POST', '/subscriptions', {
        changeType: 'created,updated,deleted',
        notificationUrl,
        resource: '/me/events',
        expirationDateTime: new Date(now() + SUBSCRIPTION_MINUTES * 60_000).toISOString(),
        clientState,
      });
      if (res.status !== 201 && res.status !== 200)
        throw microsoftError(res.status, res.body, 'Subscribing to changes');
      const body = res.body as { id: string; expirationDateTime?: string };
      const expiresAt = Date.parse(body.expirationDateTime ?? '');
      return {
        id: body.id,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + SUBSCRIPTION_MINUTES * 60_000,
      };
    },

    async unsubscribe(id) {
      const res = await call('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
      if (res.status === 204 || res.status === 200 || res.status === 404) return;
      throw microsoftError(res.status, res.body, 'Deleting the subscription');
    },
  };
}
