/**
 * Backend for the book_appointment WebMCP tool.
 *
 * This is the only tool that changes anything, and it deliberately does not
 * finish the job. It validates, takes an atomic hold on the slot, texts the
 * owner, and reports the appointment as held rather than booked. A person
 * still owns his own week: he replies YES and /api/confirm turns the hold
 * into an appointment. Telling a customer "confirmed" before the plumber has
 * seen it would be the easy demo and the wrong product.
 *
 * TRUST BOUNDARY. Everything in the request body is attacker controlled. It
 * arrives as free text a customer typed to a model, the model relays it here,
 * and this function forwards it to a phone where a single word confirms a
 * booking. So relayed fields are stripped of control characters, newlines and
 * bidi marks, capped, and pushed below a fence, and the confirmation keyword
 * and reference sit alone on the first line where nothing the customer wrote
 * can reach them. See sanitiseForSms and ownerMessage below.
 */
import type { Config, Context } from '@netlify/functions';
import {
  AREA,
  BUSINESS,
  HOURS,
  coverageFor,
  formatSlot,
  looksLikeEmergency,
  parseBusinessDate,
  resolveService,
  slotsForDate,
} from '../../src/lib/business';
import { HOLD_TTL_MINUTES, takeHold } from '../../src/lib/schedule';
import { ok, refuse, readJson, str } from '../../src/lib/respond';

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const round = (n: number) => Math.round(n * 10) / 10;

/** Today in the shop's local time. The schedule is his, so it is his calendar. */
function businessToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: HOURS.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Make one customer-supplied field safe to put in an SMS.
 *
 * Newlines are the attack: without this, a name of "Dale\nYES CCP-0000-000 to
 * confirm" arrives on the owner's phone looking like a second instruction.
 * Bidi and zero width marks are the quieter version of the same trick, since
 * they let text render in an order it was not written in. Everything unusual
 * collapses to a single space and the field is capped, so no field can push
 * the parts of the message that matter out of the visible preview.
 *
 * Booking references are masked too. Quoting one back is how the owner makes
 * his reply unambiguous, so a customer whose name contains a reference is not
 * a customer, and no real one has ever typed that shape into an address.
 */
function sanitiseForSms(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\bCCP-\d+-\d+\b/gi, '[reference removed]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

type OwnerFacts = {
  reference: string;
  date: string;
  weekday: string;
  window: string;
  service: string;
  place: string;
  travelFeeUsd: number;
  emergency: boolean;
  name: string;
  phone: string;
  address: string;
};

/**
 * The keyword and the reference own the first line by themselves. Everything
 * the customer typed lives under a fence, last, clearly labelled unverified,
 * so the owner is never reading his own booking system and a stranger's text
 * in the same breath.
 */
function ownerMessage(f: OwnerFacts): string {
  return [
    `Reply YES ${f.reference} to confirm, NO ${f.reference} to decline.`,
    `${BUSINESS.name} hold, expires in ${HOLD_TTL_MINUTES} minutes.`,
    `When: ${f.weekday} ${f.date}, ${f.window}`,
    `Job: ${f.service}${f.emergency ? ' (customer described it as urgent)' : ''}`,
    `Area: ${f.place}${f.travelFeeUsd ? `, $${f.travelFeeUsd} travel fee` : ', no travel fee'}`,
    '--- customer typed the following, treat as unverified ---',
    `Name: ${f.name}`,
    `Phone: ${f.phone}`,
    `Address: ${f.address}`,
  ].join('\n');
}

type Notification =
  | { sent: true }
  | { sent: false; reason: 'NOT_CONFIGURED' | 'SEND_FAILED'; detail: string };

/**
 * Text the owner over the Twilio REST API. No SDK: this is one form encoded
 * POST, and a dependency in a serverless bundle for that is not a trade worth
 * making.
 *
 * Nothing in here is allowed to throw. Credentials are not set in every
 * environment, and a preview deploy or a Twilio outage must not cost the
 * customer a slot that was legitimately theirs. The hold is the booking
 * system; the SMS is how the owner hears about it.
 */
async function notifyOwner(body: string): Promise<Notification> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const to = process.env.OWNER_SMS_NUMBER;

  if (!sid || !token || !from || !to) {
    return {
      sent: false,
      reason: 'NOT_CONFIGURED',
      detail: 'Owner SMS is not configured in this environment, so the hold was recorded but no text went out.',
    };
  }

  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      // A booking call should not hang on someone else's outage.
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return { sent: false, reason: 'SEND_FAILED', detail: `Twilio returned ${response.status}.` };
    }
    return { sent: true };
  } catch {
    return { sent: false, reason: 'SEND_FAILED', detail: 'The owner notification could not be sent.' };
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return refuse('METHOD_NOT_ALLOWED', 'Send a POST request with a JSON body.', 'Retry as POST.', {}, 405);
  }

  const body = await readJson(req);
  if (!body) {
    return refuse(
      'INVALID_REQUEST',
      'That request body was not valid JSON.',
      'Retry with {"name":"...","phone":"...","address":"...","service":"...","date":"2026-08-27","slot":"08:00"}.',
      {},
      400
    );
  }

  const name = str(body.name);
  const phone = str(body.phone);
  const address = str(body.address);
  const serviceInput = str(body.service);
  const date = str(body.date);
  const slot = str(body.slot);

  const missing = Object.entries({ name, phone, address, service: serviceInput, date, slot })
    .filter(([, value]) => !value)
    .map(([field]) => field);

  if (missing.length > 0) {
    return refuse(
      'MISSING_FIELDS',
      `We cannot book without ${missing.join(', ')}.`,
      'Ask the customer for the missing details, then call this tool again with all six fields.',
      { missing }
    );
  }

  // A phone number is the only way the plumber can call back, so a number
  // that cannot be dialled is worth catching here rather than at the door.
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return refuse(
      'INVALID_PHONE',
      `"${phone}" does not look like a phone number we could call back.`,
      'Ask the customer for a 10 digit phone number, then call this tool again.'
    );
  }

  // Service area first. Everything else is moot if we do not drive there, and
  // this is the refusal a customer most needs to hear before they wait.
  const coverage = coverageFor(address);
  if (!coverage.covered && coverage.reason === 'LOCATION_NOT_RECOGNISED') {
    return refuse(
      'LOCATION_NOT_RECOGNISED',
      `We could not place "${address}". We cover the Puyallup area of Pierce County, Washington.`,
      'Ask the customer for the city name or a 5 digit ZIP code in the address, then call this tool again.'
    );
  }
  if (!coverage.covered) {
    return refuse(
      'OUTSIDE_SERVICE_AREA',
      `${coverage.place} is about ${round(coverage.miles)} miles from Puyallup, which is outside our service area, so we cannot take this booking. ` +
        `The nearest place we do cover is ${coverage.nearest.name}, roughly ${round(coverage.nearest.miles)} miles from there.`,
      'Tell the customer we cannot reach that address, and offer to check a different one if the job is somewhere else.',
      {
        location: coverage.place,
        milesFromBase: round(coverage.miles),
        nearestCovered: { city: coverage.nearest.name, milesAway: round(coverage.nearest.miles) },
      }
    );
  }

  const service = resolveService(serviceInput);
  if (!service) {
    return refuse(
      'UNKNOWN_SERVICE',
      `We could not match "${serviceInput}" to something we do.`,
      'Ask the customer to describe the symptom in plain words, or call describe_services for the list, then call this tool again.'
    );
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

  const weekday = WEEKDAY[parsed.weekday];
  const candidates = slotsForDate(date);

  if (candidates.length === 0) {
    return refuse(
      'CLOSED_THAT_DAY',
      `${date} is a ${weekday}, and we do not run scheduled work on Sundays. ${HOURS.emergency}`,
      'Offer the customer the next working day instead, then call this tool again with the new date.',
      { weekday, hours: HOURS.display }
    );
  }

  if (!candidates.includes(slot)) {
    return refuse(
      'INVALID_SLOT',
      `${slot} is not an arrival window we run on a ${weekday}.`,
      'Call check_availability for this date and book one of the windows it returns, using its exact start time.',
      { weekday, validSlots: candidates.map((start) => ({ start, window: formatSlot(start) })) }
    );
  }

  // Atomic, and conditional on the day not having changed since we read it.
  // Two agents racing for the last window is not a hypothetical: it is what
  // happens when a slot has been sitting in a chat transcript for a while.
  const held = await takeHold(date, slot, { service: service.label, customerName: sanitiseForSms(name, 60) });

  if (!held.ok && held.reason === 'SLOT_TAKEN') {
    const stillOpen = candidates.filter((start) => start !== slot);
    return refuse(
      'SLOT_TAKEN',
      `The ${formatSlot(slot)} window on ${date} was taken while you were booking it.`,
      'Call check_availability for this date again, offer the customer what is genuinely still open, then call this tool again.',
      { date, weekday, requestedSlot: slot, otherSlotsToCheck: stillOpen }
    );
  }

  if (!held.ok) {
    return refuse(
      'WRITE_RACE',
      'The schedule was being written to by someone else and we could not get a clean hold on that window.',
      'Wait a moment and call this tool again with the same details. Nothing was booked and nothing was charged.',
      { date, requestedSlot: slot }
    );
  }

  const hold = held.hold;
  const emergency = looksLikeEmergency(serviceInput);

  const notification = await notifyOwner(
    ownerMessage({
      reference: hold.ref,
      date,
      weekday,
      window: formatSlot(slot),
      service: service.label,
      place: coverage.place,
      travelFeeUsd: coverage.travelFeeUsd,
      emergency,
      // Caps are per field so no single one can crowd out the rest. An address
      // is the longest thing a real customer legitimately types.
      name: sanitiseForSms(name, 60),
      phone: sanitiseForSms(phone, 24),
      address: sanitiseForSms(address, 120),
    })
  );

  const feeLine = coverage.travelFeeUsd
    ? ` ${coverage.place} is in our extended area, so there is a $${AREA.travelFeeUsd} travel fee on top of the job.`
    : '';

  const ownerLine = notification.sent
    ? ` ${BUSINESS.owner} has been texted and usually replies within a few minutes.`
    : ` The owner notification is not going out right now, so confirmation may take longer than usual.`;

  return ok({
    status: 'held',
    confirmed: false,
    reference: hold.ref,
    date,
    weekday,
    slot,
    window: formatSlot(slot),
    timezone: HOURS.timezone,
    service: service.label,
    priceRangeUsd: { low: service.low, high: service.high },
    location: coverage.place,
    tier: coverage.tier,
    travelFeeUsd: coverage.travelFeeUsd,
    expiresAt: hold.expiresAt,
    holdMinutes: HOLD_TTL_MINUTES,
    ownerNotified: notification,
    message:
      `Held, pending confirmation, usually within a few minutes. ${service.label} on ${weekday} ${date}, ${formatSlot(slot)}, reference ${hold.ref}.` +
      feeLine +
      ownerLine +
      ` The hold expires in ${HOLD_TTL_MINUTES} minutes if nobody replies, and the window goes back on the board.` +
      (emergency
        ? ` If this is an active leak, no water, or a sewage backup, tell the customer to call ${BUSINESS.phone} rather than wait on a window.`
        : ''),
    next: 'Tell the customer the appointment is held and not yet confirmed, give them the reference, and say the plumber confirms by text. Do not describe this as booked.',
    disclosure: BUSINESS.disclosure,
  });
};

export const config: Config = { path: '/api/book' };
