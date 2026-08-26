/**
 * Backend for the check_availability WebMCP tool.
 *
 * Never returns a slot that cannot actually be booked. It reads live holds
 * from Blobs with strong consistency rather than a cached view, because an
 * agent that is handed a stale slot will try to book it and the refusal will
 * arrive after the customer has already been told yes.
 */
import type { Config, Context } from '@netlify/functions';
import {
  HOURS,
  formatSlot,
  looksLikeEmergency,
  parseBusinessDate,
  resolveService,
  slotsForDate,
} from '../../src/lib/business';
import { takenSlots } from '../../src/lib/schedule';
import { ok, refuse, readJson, str } from '../../src/lib/respond';

/** Today in the shop's local time, as YYYY-MM-DD. */
function businessToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: HOURS.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return refuse('METHOD_NOT_ALLOWED', 'Send a POST request with a JSON body.', 'Retry as POST.', {}, 405);
  }
  const body = await readJson(req);
  if (!body) {
    return refuse('INVALID_REQUEST', 'That request body was not valid JSON.', 'Retry with {"service":"drain","date":"2026-08-27"}.', {}, 400);
  }

  const date = str(body.date);
  const serviceInput = str(body.service);

  if (!date) {
    return refuse('MISSING_DATE', 'No date was provided.', 'Ask the customer which day suits them, then call this tool again with an ISO date like 2026-08-27.');
  }

  const parsed = parseBusinessDate(date);
  if (!parsed) {
    return refuse(
      'INVALID_DATE',
      `"${date}" is not a date we can read.`,
      'Convert the customer\'s day into ISO format, YYYY-MM-DD, and call this tool again.'
    );
  }

  const today = businessToday();
  if (date < today) {
    return refuse(
      'DATE_IN_PAST',
      `${date} has already been and gone. Today is ${today}.`,
      'Confirm which upcoming day the customer meant, then call this tool again.',
      { today }
    );
  }

  const service = serviceInput ? resolveService(serviceInput) : null;
  if (serviceInput && !service) {
    return refuse(
      'UNKNOWN_SERVICE',
      `We could not match "${serviceInput}" to something we do.`,
      'Ask the customer to describe the symptom, then call this tool again.'
    );
  }

  const candidates = slotsForDate(date);
  const weekday = WEEKDAY[parsed.weekday];

  if (candidates.length === 0) {
    return refuse(
      'CLOSED_THAT_DAY',
      `${date} is a ${weekday}, and we do not run scheduled work on Sundays. ${HOURS.emergency}`,
      'Offer the customer the next working day instead, or ask whether this is a genuine emergency.',
      { weekday, hours: HOURS.display }
    );
  }

  const taken = await takenSlots(date);
  const open = candidates.filter((slot) => !taken.has(slot));

  if (open.length === 0) {
    return refuse(
      'FULLY_BOOKED',
      `We are fully booked on ${date}, a ${weekday}.`,
      'Offer the customer another day, and call this tool again with the new date.',
      { weekday, bookedSlots: candidates.length }
    );
  }

  const emergency = looksLikeEmergency(serviceInput);

  return ok({
    date,
    weekday,
    service: service?.label ?? null,
    timezone: HOURS.timezone,
    slots: open.map((start) => ({ start, window: formatSlot(start), type: 'standard' })),
    message:
      `On ${weekday} ${date} we have ${open.length} arrival window${open.length === 1 ? '' : 's'} open: ` +
      `${open.map(formatSlot).join(', ')}. Windows are two hours wide.` +
      (emergency ? ` If this is an active leak, no water, or a sewage backup, we come out around the clock and do not wait for a window.` : ''),
    emergencyPolicy: HOURS.emergency,
    next: 'Confirm the address is in the service area, then book one of these windows.',
  });
};

export const config: Config = { path: '/api/availability' };
