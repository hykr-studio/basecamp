import { z } from 'zod';
import { minutesOf, type OpenHours, WEEKDAYS } from '../framework/business-time.js';
import { defineSettingsSection } from './sections.js';

const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'A time of day: HH:MM, 00:00 to 24:00');

const Interval = z
  .object({ from: TimeOfDay, to: TimeOfDay })
  .refine((i) => minutesOf(i.from) < minutesOf(i.to), 'An interval ends after it starts');

const Week = z
  .object(Object.fromEntries(WEEKDAYS.map((d) => [d, z.array(Interval).max(8).optional()])))
  .refine(
    (w) => Object.values(w).some((list) => Array.isArray(list) && list.length > 0),
    'A working week needs at least one open interval',
  );

/**
 * When the business is open, in its own time zone (`timeZone`): what SLAs counting business
 * hours count. Without `week`, every hour of every day but a holiday counts. The framework
 * assumes no working week of its own.
 */
export const BusinessHours = z
  .object({
    /** Open intervals per weekday ('mon' … 'sun'); a day not listed is closed. */
    week: Week.optional(),
    /** Whole days closed, as local dates. */
    holidays: z.array(z.iso.date()).max(1000).default([]),
  })
  .default({ holidays: [] });
export type BusinessHours = z.infer<typeof BusinessHours>;

declare module './sections.js' {
  interface TenantSettingsSections {
    businessHours: BusinessHours;
  }
}

export const BusinessHoursSection = defineSettingsSection('businessHours', BusinessHours);

/** The settings as `addBusinessTime` takes them. */
export const openHoursOf = (s: BusinessHours | undefined): OpenHours => ({
  ...(s?.week ? { week: s.week as OpenHours['week'] } : {}),
  holidays: s?.holidays ?? [],
});
