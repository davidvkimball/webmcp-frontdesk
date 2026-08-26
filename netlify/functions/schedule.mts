/**
 * Read-only view of the schedule, for the dispatch board.
 *
 * This exists so the state the tools mutate is visible. It is not a tool and
 * it is not registered with the model context: an agent already has
 * check_availability for open windows and check_hold_status for its own
 * booking, and giving it a firehose of every customer on the board would be
 * both useless to it and a privacy problem.
 *
 * Customer phone numbers are stored on holds and are deliberately never
 * included here. The board is public.
 */
import type { Config, Context } from '@netlify/functions';
import { HOURS, formatSlot, parseBusinessDate, slotsForDate } from '../../src/lib/business';
import { listDayKeys, readDay, isLive } from '../../src/lib/schedule';

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_AHEAD = 10;

function businessToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: HOURS.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export default async (_req: Request, _context: Context) => {
  const today = businessToday();
  const window = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(today, i));

  // Only read days that actually have holds. Most days in the window are
  // untouched, and a strong-consistency read per empty day is wasted latency
  // on an endpoint that gets polled every couple of seconds.
  const withHolds = new Set(await listDayKeys());
  const days = [];

  for (const date of window) {
    const candidates = slotsForDate(date);
    const parsed = parseBusinessDate(date);
    const holds = withHolds.has(date) ? (await readDay(date)).day.holds : [];
    const bySlot = new Map(holds.map((h) => [h.slot, h]));

    days.push({
      date,
      weekday: WEEKDAY[parsed?.weekday ?? 0],
      isToday: date === today,
      closed: candidates.length === 0,
      slots: candidates.map((start) => {
        const hold = bySlot.get(start);
        if (!hold) return { start, window: formatSlot(start), status: 'open' as const };
        const status =
          hold.status === 'held' && !isLive(hold) ? ('expired' as const) : (hold.status as string);
        return {
          start,
          window: formatSlot(start),
          status,
          reference: hold.ref,
          service: hold.service,
          customerName: hold.customerName,
          createdAt: hold.createdAt,
          expiresAt: hold.status === 'held' ? hold.expiresAt : null,
        };
      }),
    });
  }

  const flat = days.flatMap((d) => d.slots);
  return new Response(
    JSON.stringify({
      ok: true,
      generatedAt: new Date().toISOString(),
      timezone: HOURS.timezone,
      today,
      counts: {
        pending: flat.filter((s) => s.status === 'held').length,
        confirmed: flat.filter((s) => s.status === 'confirmed').length,
        open: flat.filter((s) => s.status === 'open').length,
      },
      days,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // Polled. A cached answer defeats the entire point of the board.
        'cache-control': 'no-store',
      },
    }
  );
};

export const config: Config = { path: '/api/schedule' };
