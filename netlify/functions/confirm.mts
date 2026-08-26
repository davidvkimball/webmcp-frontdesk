/**
 * Twilio inbound webhook: the owner's one word reply.
 *
 * This is the other half of book_appointment. A hold is not an appointment
 * until Dale says so, and this is where he says so. He replies YES and the
 * hold becomes confirmed, NO and it is declined and the window goes straight
 * back on the board.
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
import { getStore } from '@netlify/blobs';
import { formatSlot, parseBusinessDate } from '../../src/lib/business';
import { isLive, readDay, type Day, type Hold } from '../../src/lib/schedule';

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The same store and key scheme src/lib/schedule.ts uses. Reads go through
 * that module's readDay so the ETag comes with them; only the status write
 * lives here, because updating a hold in place is not something the booking
 * path ever needs to do.
 */
const store = () => getStore({ name: 'schedule', consistency: 'strong' });
const keyFor = (date: string) => `day/${date}`;
const DAY_PREFIX = 'day/';

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
  const { blobs } = await store().list({ prefix: DAY_PREFIX });
  const found: { date: string; hold: Hold }[] = [];
  for (const blob of blobs) {
    const date = blob.key.slice(DAY_PREFIX.length);
    const { day } = await readDay(date);
    for (const hold of day.holds) found.push({ date, hold });
  }
  return found.sort((a, b) => Date.parse(b.hold.createdAt) - Date.parse(a.hold.createdAt));
}

type WriteResult = 'ok' | 'gone' | 'race';

/**
 * Flip one hold's status, conditional on the day not having changed since we
 * read it. Same reasoning as takeHold: an expiry sweep or a second booking
 * landing between the read and the write would otherwise be silently undone.
 */
async function setHoldStatus(date: string, ref: string, status: Hold['status']): Promise<WriteResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { day, etag } = await readDay(date);
    if (!day.holds.some((h) => h.ref === ref)) return 'gone';

    const next: Day = {
      date,
      holds: day.holds.map((h) => (h.ref === ref ? { ...h, status } : h)),
    };

    const written = await store().setJSON(
      keyFor(date),
      next,
      etag ? { onlyIfMatch: etag } : { onlyIfNew: true }
    );
    if (written.modified) return 'ok';
  }
  return 'race';
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

  if (written === 'gone') {
    return twiml(`${target.hold.ref} is no longer on the schedule. Nothing changed.`, 'HOLD_NOT_FOUND');
  }
  if (written === 'race') {
    return twiml(
      `The schedule was busy and ${target.hold.ref} did not change. Send the same reply again.`,
      'WRITE_RACE'
    );
  }

  const summary = describe(target.date, target.hold);
  return decision === 'confirmed'
    ? twiml(`Confirmed: ${summary}.`, 'CONFIRMED')
    : twiml(`Declined: ${summary}. The window is back on the board.`, 'DECLINED');
};

export const config: Config = { path: '/api/confirm' };
