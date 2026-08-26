/**
 * Twilio inbound webhook: the owner's one word reply.
 *
 * This is the other half of book_appointment. A hold is not an appointment
 * until Dale says so, and this is where he says so. He replies YES and the
 * hold becomes confirmed, NO and it is declined and the window goes straight
 * back on the board. Either way the customer hears about it, because a booking
 * nobody told the customer about is not a booking.
 *
 * TRUST BOUNDARY. This endpoint is a public URL that flips a booking, so the
 * only thing standing between a stranger and the schedule is who we believe
 * sent the text. Two checks, in order:
 *
 * 1. The Twilio request signature, an HMAC over the URL and the posted fields
 *    keyed on the auth token. This is the check that actually holds, because
 *    a From field is just a string anyone can post.
 * 2. The From number against OWNER_SMS_NUMBER, compared on digits so that
 *    +1 253 555 0142 and 2535550142 are the same person.
 *
 * Nothing customer-supplied is echoed back in the reply. Everything in the
 * outbound TwiML comes from our own schedule, so the message that lands on
 * the owner's phone cannot be authored by the person who booked.
 */
import type { Config, Context } from '@netlify/functions';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { BUSINESS, formatSlot, parseBusinessDate } from '../../src/lib/business';
import { isLive, listDayKeys, readDay, setHoldStatus, type Hold } from '../../src/lib/schedule';

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const xmlEscape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * Twilio wants TwiML back, and whatever is in it gets sent to the owner as a
 * reply. A null message means answer politely and say nothing, which is what
 * an unrecognised sender gets: we do not text strangers, and we do not tell
 * them what this endpoint does.
 *
 * The reason code lives in a header rather than the body for the same reason.
 * It keeps the stable machine-readable code the other tools return without
 * putting it in front of a person who only wanted to reply YES.
 */
const twiml = (message: string | null, reason: string, status = 200) =>
  new Response(
    message === null
      ? '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
      : `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`,
    {
      status,
      headers: {
        'content-type': 'text/xml; charset=utf-8',
        'cache-control': 'no-store',
        'x-frontdesk-reason': reason,
      },
    }
  );

/** Compare phone numbers on their last ten digits, so formatting cannot matter. */
function samePhone(a: string, b: string): boolean {
  const digits = (s: string) => s.replace(/\D/g, '').slice(-10);
  const left = digits(a);
  const right = digits(b);
  return left.length === 10 && left === right;
}

/** Twilio's scheme: the full URL, then every field appended as key then value, sorted by key. */
function expectedSignature(url: string, params: URLSearchParams, token: string): string {
  let data = url;
  for (const key of [...new Set(params.keys())].sort()) data += key + params.getAll(key).join('');
  return createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}

function signatureMatches(candidateUrls: string[], params: URLSearchParams, token: string, sent: string): boolean {
  const given = Buffer.from(sent, 'utf8');
  return candidateUrls.some((url) => {
    const mine = Buffer.from(expectedSignature(url, params, token), 'utf8');
    return mine.length === given.length && timingSafeEqual(mine, given);
  });
}

/**
 * The URL Twilio signed is the one it called, which is not always the one this
 * function sees after proxying. Try the request URL and the forwarded host
 * reconstruction rather than failing a legitimate reply over a scheme.
 */
function candidateUrls(req: Request): string[] {
  const urls = new Set<string>([req.url]);
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host) {
    const proto = req.headers.get('x-forwarded-proto') ?? 'https';
    const path = new URL(req.url).pathname;
    urls.add(`${proto}://${host}${path}`);
  }
  return [...urls];
}

/** Every hold we know about, newest first. Small by construction: one document per day. */
async function allHolds(): Promise<{ date: string; hold: Hold }[]> {
  const dates = await listDayKeys();
  const found: { date: string; hold: Hold }[] = [];
  for (const date of dates) {
    const { day } = await readDay(date);
    for (const hold of day.holds) found.push({ date, hold });
  }
  return found.sort((a, b) => Date.parse(b.hold.createdAt) - Date.parse(a.hold.createdAt));
}

/**
 * Same treatment book.mts gives anything a customer typed, for the same
 * reason: this text is on its way into an SMS, and a name carrying newlines
 * or bidi marks can make a message render as something nobody wrote.
 */
function sanitiseForSms(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\bCCP-\d+-\d+\b/gi, '[reference removed]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Twilio will not dial "(253) 555 0199". A customer types a number the way
 * they say it out loud, so assume North America when the country code is
 * missing rather than dropping the message.
 */
function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+') && digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

/**
 * Text the customer over the Twilio REST API, same one form encoded POST that
 * book.mts uses to reach the owner. No SDK.
 *
 * Nothing in here throws and nothing it returns changes the outcome of the
 * confirmation. The owner has already replied and the status has already been
 * written, so a missing credential or a carrier rejection is a message that
 * did not land, not a booking that did not happen. Missing credentials is the
 * normal state in a preview deploy and must stay boring.
 */
async function notifyCustomer(toRaw: string, body: string, ref: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    console.log(`[confirm] ${ref}: customer SMS skipped, Twilio is not configured in this environment.`);
    return;
  }

  const to = toE164(toRaw);
  if (!to) {
    console.log(`[confirm] ${ref}: customer SMS skipped, no dialable number on the hold.`);
    return;
  }

  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      // Twilio expects its webhook answered promptly, so this waits on nobody.
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      console.log(`[confirm] ${ref}: customer SMS not accepted, Twilio returned ${response.status}.`);
      return;
    }
    console.log(`[confirm] ${ref}: customer SMS sent.`);
  } catch {
    console.log(`[confirm] ${ref}: customer SMS failed to send.`);
  }
}

/**
 * What the customer reads. Everything load-bearing comes from our own
 * schedule; the only customer-authored thing in it is their own first name,
 * and that has been through sanitiseForSms twice by now.
 */
function customerMessage(date: string, hold: Hold, decision: Hold['status']): string {
  const parsed = parseBusinessDate(date);
  const when = `${parsed ? `${WEEKDAY[parsed.weekday]} ` : ''}${date}, ${formatSlot(hold.slot)}`;
  const greeting = sanitiseForSms(hold.customerName, 40).split(' ')[0] ?? '';
  const opener = greeting ? `${greeting}, ` : '';

  return decision === 'confirmed'
    ? `${opener}your appointment with ${BUSINESS.name} is confirmed. ${when}. Job: ${hold.service}. Reference ${hold.ref}. ` +
        `Call ${BUSINESS.phone} if anything changes.`
    : `${opener}${BUSINESS.name} could not confirm that window, so nothing is booked. ${when} is back on the board for someone else. ` +
        `Reference ${hold.ref}. Pick another time and we will get you in, or call ${BUSINESS.phone}.`;
}

function describe(date: string, hold: Hold): string {
  const parsed = parseBusinessDate(date);
  const weekday = parsed ? `${WEEKDAY[parsed.weekday]} ` : '';
  return `${hold.ref}, ${hold.service}, ${weekday}${date}, ${formatSlot(hold.slot)}`;
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return twiml(null, 'METHOD_NOT_ALLOWED', 405);
  }

  // Twilio posts application/x-www-form-urlencoded. Read it as text first so
  // a malformed body is a refusal rather than a thrown exception.
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await req.text());
  } catch {
    return twiml(null, 'INVALID_REQUEST', 400);
  }

  const owner = process.env.OWNER_SMS_NUMBER ?? '';
  if (!owner) {
    // With no number to check against there is nobody we can trust, so this
    // fails closed rather than confirming bookings for whoever texts first.
    return twiml(null, 'NOT_CONFIGURED', 503);
  }

  const token = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers.get('x-twilio-signature');
  if (token && signature) {
    if (!signatureMatches(candidateUrls(req), params, token, signature)) {
      return twiml(null, 'INVALID_SIGNATURE', 403);
    }
  }

  const from = params.get('From') ?? '';
  if (!samePhone(from, owner)) {
    // Say nothing back. A stranger who finds this URL learns only that it exists.
    return twiml(null, 'UNAUTHORISED_SENDER', 403);
  }

  const text = (params.get('Body') ?? '').trim();
  const word = text.split(/\s+/)[0]?.toUpperCase().replace(/[^A-Z]/g, '') ?? '';
  const decision =
    word === 'YES' || word === 'Y' || word === 'CONFIRM'
      ? 'confirmed'
      : word === 'NO' || word === 'N' || word === 'DECLINE'
        ? 'declined'
        : null;

  if (!decision) {
    return twiml('Reply YES to confirm the pending booking, or NO to decline it.', 'UNREADABLE_REPLY');
  }

  // The reference, when he quotes it back, is what makes the reply
  // unambiguous. Without one we take the most recent live hold, which is the
  // only sensible reading of a bare YES.
  const quotedRef = text.match(/\bCCP-\d+-\d+\b/i)?.[0].toUpperCase() ?? null;
  const holds = await allHolds();

  const target = quotedRef
    ? holds.find((entry) => entry.hold.ref.toUpperCase() === quotedRef)
    : holds.find((entry) => entry.hold.status === 'held' && isLive(entry.hold));

  if (!target) {
    return quotedRef
      ? twiml(`No booking here with reference ${quotedRef}.`, 'HOLD_NOT_FOUND')
      : twiml('There is nothing waiting on a reply right now.', 'NO_PENDING_HOLD');
  }

  if (target.hold.status !== 'held') {
    return twiml(
      `${target.hold.ref} was already ${target.hold.status}. Nothing changed.`,
      'ALREADY_RESOLVED'
    );
  }

  if (!isLive(target.hold)) {
    return twiml(
      `${target.hold.ref} expired before this reply, so the window went back on the board. Nothing changed.`,
      'HOLD_EXPIRED'
    );
  }

  const written = await setHoldStatus(target.date, target.hold.ref, decision);

  if (!written.ok && written.reason === 'HOLD_NOT_FOUND') {
    return twiml(`${target.hold.ref} is no longer on the schedule. Nothing changed.`, 'HOLD_NOT_FOUND');
  }
  if (!written.ok) {
    return twiml(
      `The schedule was busy and ${target.hold.ref} did not change. Send the same reply again.`,
      'WRITE_RACE'
    );
  }

  // The decision is already durable. Closing the loop with the customer is the
  // last beat and the one everybody forgets, but it is not allowed to undo it,
  // so this is awaited for the log line and its result is deliberately ignored.
  await notifyCustomer(
    written.hold.customerPhone ?? '',
    customerMessage(target.date, written.hold, decision),
    written.hold.ref
  );

  const summary = describe(target.date, target.hold);
  return decision === 'confirmed'
    ? twiml(`Confirmed: ${summary}.`, 'CONFIRMED')
    : twiml(`Declined: ${summary}. The window is back on the board.`, 'DECLINED');
};

export const config: Config = { path: '/api/confirm' };
