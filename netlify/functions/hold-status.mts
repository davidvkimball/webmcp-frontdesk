/**
 * Backend for check_hold_status, one of the two conversation-scoped tools.
 *
 * This tool does not exist when the page loads. It is registered only once a
 * booking has produced a hold, and unregistered the moment that hold stops
 * being pending. An agent cannot ask about a hold that was never made.
 */
import type { Config, Context } from '@netlify/functions';
import { formatSlot } from '../../src/lib/business';
import { findHold, isLive } from '../../src/lib/schedule';
import { ok, refuse, readJson, str } from '../../src/lib/respond';

const HUMAN: Record<string, string> = {
  held: 'still pending, waiting on the owner to confirm',
  confirmed: 'confirmed by the owner',
  declined: 'declined by the owner',
  cancelled: 'cancelled by the customer',
};

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return refuse('METHOD_NOT_ALLOWED', 'Send a POST request with a JSON body.', 'Retry as POST.', {}, 405);
  }
  const body = await readJson(req);
  const reference = str(body?.reference);

  if (!reference) {
    return refuse(
      'MISSING_REFERENCE',
      'No booking reference was provided.',
      'Use the reference that book_appointment returned earlier in this conversation.'
    );
  }

  const found = await findHold(reference);
  if (!found) {
    return refuse(
      'HOLD_NOT_FOUND',
      `We have no record of a booking with reference ${reference}.`,
      'Check the reference against what book_appointment returned. Do not invent one.',
      { reference }
    );
  }

  const { hold, date } = found;
  const expired = hold.status === 'held' && !isLive(hold);

  return ok({
    reference: hold.ref,
    status: expired ? 'expired' : hold.status,
    confirmed: hold.status === 'confirmed',
    date,
    slot: hold.slot,
    window: formatSlot(hold.slot),
    service: hold.service,
    expiresAt: hold.status === 'held' ? hold.expiresAt : null,
    message: expired
      ? `Hold ${hold.ref} expired before the owner replied, so the ${formatSlot(hold.slot)} window on ${date} is open again.`
      : `Booking ${hold.ref} for ${formatSlot(hold.slot)} on ${date} is ${HUMAN[hold.status]}.`,
    next:
      hold.status === 'confirmed'
        ? 'Tell the customer it is confirmed and they do not need to do anything else.'
        : expired || hold.status === 'declined' || hold.status === 'cancelled'
          ? 'Offer to check availability again and book a different window.'
          : 'Tell the customer it is still pending. Do not describe it as confirmed.',
  });
};

export const config: Config = { path: '/api/hold-status' };
