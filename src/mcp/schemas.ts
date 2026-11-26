import { z } from 'zod';

// A YYYY-MM-DD string that is a real calendar date (2026-13-45 and 2026-02-30 are not).
export const realDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(v => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, 'not a real date');

/** A time of day, HH:MM in 24 hours. */
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM in 24 hours');
