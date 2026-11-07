// Calendars and calls:
//   when am I free tomorrow for 60 minutes      find-free-time (the person's connected calendar)
//   invite a@b.c to <entity> <id>               send-calendar-invite (to anyone else: approval)
//   log a call on <entity> <id>: <notes>        log-call (completed, outbound)
//   call +<number>                              dial-call (always waits for approval)
import { call, defineScript, say, startOfDay, written } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

const ENTITY = '([a-zA-Z][a-zA-Z0-9]*)';
const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

/** "09:00" in the person's zone. */
const clock = (iso: string, zone: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone });

const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const calendarScripts = defineScriptSet({
  name: 'calendar',
  order: 320,
  scripts: [
    defineScript({
      name: 'free-time',
      match: (text) => {
        const m = /^when am i free (today|tomorrow)(?: for (\d{1,3}) minutes)?\??$/i.exec(
          text.trim(),
        );
        return m ? { day: m[1].toLowerCase(), minutes: Number(m[2] ?? 60) } : undefined;
      },
      step: ({ day, minutes }, turn) => {
        const r = turn.result('find-free-time');
        if (!r) {
          const ymd = day === 'today' ? turn.today : addDays(turn.today, 1);
          const from = startOfDay(ymd, turn.zone);
          const to = startOfDay(addDays(ymd, 1), turn.zone);
          return [
            call('find-free-time', {
              from: (day === 'today' && from < new Date() ? new Date() : from).toISOString(),
              to: to.toISOString(),
              minutes,
              hoursFrom: '09:00',
              hoursTo: '18:00',
              limit: 5,
            }),
          ];
        }
        if (!r.ok) return [say("I couldn't read your calendar.")];
        const out = r.result as { connected: boolean; slots: { start: string }[] };
        if (!out.connected)
          return [say('No calendar is connected yet: connect one under Calendar.')];
        if (!out.slots.length) return [say(`You have no free ${minutes} minutes ${day}.`)];
        return [
          say(
            `You're free ${day} at ${out.slots.map((s) => clock(s.start, turn.zone)).join(', ')}.`,
          ),
        ];
      },
    }),
    defineScript({
      name: 'calendar-invite',
      match: (text) => {
        const m = new RegExp(`^invite (\\S+@\\S+) to ${ENTITY} ${ID}$`, 'i').exec(text.trim());
        return m ? { email: m[1], entity: m[2], id: m[3] } : undefined;
      },
      step: ({ email, entity, id }, turn) => {
        const r = turn.result('send-calendar-invite');
        if (!r) return [call('send-calendar-invite', { entity, id, to: [{ email }] })];
        if (!r.ok) return [say("I couldn't send that invite.")];
        return [say(written(r, () => `I've sent ${email} a calendar invite.`, turn))];
      },
    }),
    defineScript({
      name: 'log-call',
      match: (text) => {
        const m = new RegExp(`^log a call on ${ENTITY} ${ID}: (.+)$`, 'i').exec(text.trim());
        return m ? { entity: m[1], id: m[2], notes: m[3] } : undefined;
      },
      step: ({ entity, id, notes }, turn) => {
        const r = turn.result('log-call');
        if (!r)
          return [
            call('log-call', { direction: 'outbound', status: 'completed', entity, id, notes }),
          ];
        if (!r.ok) return [say("I couldn't log that call.")];
        return [say(written(r, () => 'Logged the call.', turn))];
      },
    }),
    defineScript({
      name: 'dial-call',
      match: (text) => /^call (\+[1-9]\d{7,14})$/i.exec(text.trim())?.[1],
      step: (to, turn) => {
        const r = turn.result('dial-call');
        if (!r) return [call('dial-call', { to })];
        if (!r.ok) return [say("I can't place calls for this business.")];
        return [say(written(r, () => `Calling ${to}.`, turn))];
      },
    }),
  ],
});
