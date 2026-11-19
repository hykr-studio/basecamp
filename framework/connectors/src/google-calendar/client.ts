// The parts of the Google Calendar API a connection uses: our events (upsert, delete), what
// changed since the last look (sync tokens), busy times, and push channels (watch, stop).
import {
  GOOGLE_ENDPOINTS,
  GoogleApiError,
  type GoogleEndpoints,
  type GoogleTransport,
  googleError,
} from './transport.js';

/** A time on an event: a moment (`dateTime`) or, for all-day events, a `date`. */
export interface GoogleTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

/** An event, as much of it as a connection reads or writes. */
export interface GoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  updated?: string;
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
}

/** What changed in a calendar since a sync token, and the token for next time. */
export interface GoogleChanges {
  items: GoogleEvent[];
  nextSyncToken: string;
  /** The old token had expired (410): `items` is the whole calendar, not changes. */
  reset: boolean;
}

/** A busy interval, as ISO date-times. */
export interface BusyInterval {
  start: string;
  end: string;
}

/** A push channel Google opened. `expiration` is epoch milliseconds. */
export interface GoogleChannel {
  id: string;
  resourceId: string;
  expiration: number;
}

/** Event ids Google accepts: base32hex (a–v, 0–9), 5 to 1024 characters. */
export const EVENT_ID = /^[a-v0-9]{5,1024}$/;

const cal = (id: string) => encodeURIComponent(id);

/** Most pages read while listing changes: a larger calendar is listed again next time. */
const MAX_PAGES = 40;

export interface GoogleCalendarClient {
  /** Put this event in the calendar under its id: replaced if it is there (or was deleted). */
  upsertEvent(calendarId: string, event: GoogleEvent): Promise<GoogleEvent>;
  /** Take it out. Already gone is fine. */
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  /** What changed since `syncToken` (deleted events included); without one, every event. */
  changes(calendarId: string, syncToken?: string | null): Promise<GoogleChanges>;
  /** Busy intervals between two times, merged across the calendars asked for. */
  freeBusy(a: { from: string; to: string; calendars?: string[] }): Promise<BusyInterval[]>;
  /** Ask Google to post to `address` when the calendar's events change. */
  watch(
    calendarId: string,
    a: { id: string; token: string; address: string; ttlSeconds?: number },
  ): Promise<GoogleChannel>;
  /** Close a channel. Already closed is fine. */
  stopChannel(a: { id: string; resourceId: string }): Promise<void>;
}

/** A client for one person's calendars, with an access token. */
export function googleCalendarClient(
  transport: GoogleTransport,
  a: { accessToken: string; endpoints?: GoogleEndpoints },
): GoogleCalendarClient {
  const api = (a.endpoints ?? GOOGLE_ENDPOINTS).api;
  const headers = {
    authorization: `Bearer ${a.accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
    transport({
      method,
      url: `${api}${path}`,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    async upsertEvent(calendarId, event) {
      if (!EVENT_ID.test(event.id)) throw new Error(`"${event.id}" is not a Google event id`);
      const path = `/calendars/${cal(calendarId)}/events`;
      const body = { ...event, status: event.status ?? 'confirmed' };
      // Update first: it also brings back an event that was deleted (Google keeps its id).
      let res = await call('PUT', `${path}/${cal(event.id)}`, body);
      if (res.status === 404 || res.status === 410) {
        res = await call('POST', path, body);
        // Made by someone else in between: update it.
        if (res.status === 409) res = await call('PUT', `${path}/${cal(event.id)}`, body);
      }
      if (res.status !== 200) throw googleError(res.status, res.body, 'Saving the event');
      return res.body as GoogleEvent;
    },

    async deleteEvent(calendarId, eventId) {
      const res = await call(
        'DELETE',
        `/calendars/${cal(calendarId)}/events/${cal(eventId)}?sendUpdates=none`,
      );
      if (res.status === 204 || res.status === 200 || res.status === 404 || res.status === 410)
        return;
      throw googleError(res.status, res.body, 'Deleting the event');
    },

    async changes(calendarId, syncToken) {
      const list = async (token: string | null | undefined) => {
        const items: GoogleEvent[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const q = new URLSearchParams({ maxResults: '250', showDeleted: 'true' });
          if (token) q.set('syncToken', token);
          if (pageToken) q.set('pageToken', pageToken);
          const res = await call('GET', `/calendars/${cal(calendarId)}/events?${q}`);
          if (res.status === 410 && token) return null;
          if (res.status !== 200) throw googleError(res.status, res.body, 'Listing changes');
          const body = res.body as {
            items?: GoogleEvent[];
            nextPageToken?: string;
            nextSyncToken?: string;
          };
          items.push(...(body.items ?? []));
          if (body.nextSyncToken) return { items, nextSyncToken: body.nextSyncToken };
          if (!body.nextPageToken) break;
          pageToken = body.nextPageToken;
        }
        throw new GoogleApiError(0, 'too_many_pages', 'The calendar has too many changes to list');
      };
      const changed = await list(syncToken);
      if (changed) return { ...changed, reset: false };
      // The token expired (Google answers 410): start again from the whole calendar.
      const all = await list(null);
      if (!all) throw new GoogleApiError(410, 'gone', 'Google refused a full listing');
      return { ...all, reset: true };
    },

    async freeBusy({ from, to, calendars = ['primary'] }) {
      const res = await call('POST', '/freeBusy', {
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        items: calendars.map((id) => ({ id })),
      });
      if (res.status !== 200) throw googleError(res.status, res.body, 'Reading busy times');
      const body = res.body as {
        calendars?: Record<string, { busy?: BusyInterval[]; errors?: { reason?: string }[] }>;
      };
      const busy: BusyInterval[] = [];
      for (const id of calendars) {
        const c = body.calendars?.[id];
        if (c?.errors?.length)
          throw new GoogleApiError(
            200,
            c.errors[0].reason,
            `Google could not read ${id}: ${c.errors[0].reason ?? 'unknown'}`,
          );
        busy.push(...(c?.busy ?? []));
      }
      return mergeBusy(busy);
    },

    async watch(calendarId, w) {
      const res = await call('POST', `/calendars/${cal(calendarId)}/events/watch`, {
        id: w.id,
        type: 'web_hook',
        address: w.address,
        token: w.token,
        ...(w.ttlSeconds ? { params: { ttl: String(w.ttlSeconds) } } : {}),
      });
      if (res.status !== 200) throw googleError(res.status, res.body, 'Opening a channel');
      const body = res.body as { id: string; resourceId: string; expiration?: string | number };
      return {
        id: body.id,
        resourceId: body.resourceId,
        expiration: Number(body.expiration ?? Date.now() + 7 * 86_400_000),
      };
    },

    async stopChannel({ id, resourceId }) {
      const res = await call('POST', '/channels/stop', { id, resourceId });
      if (res.status === 204 || res.status === 200 || res.status === 404) return;
      throw googleError(res.status, res.body, 'Closing the channel');
    },
  };
}

/** Busy intervals sorted and merged where they touch or overlap. */
export function mergeBusy(busy: readonly BusyInterval[]): BusyInterval[] {
  const sorted = busy
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((x, y) => x.start - y.start);
  const out: { start: number; end: number }[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
  }
  return out.map((b) => ({
    start: new Date(b.start).toISOString(),
    end: new Date(b.end).toISOString(),
  }));
}
