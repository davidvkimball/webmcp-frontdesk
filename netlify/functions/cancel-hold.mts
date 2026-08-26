/**
 * Backend for cancel_hold, the second conversation-scoped tool.
 *
 * Registered only while a hold is pending. That is the point: an agent has no
 * cancel capability at all until there is something to cancel, so the tool
 * surface itself encodes what is currently possible rather than relying on the
 * model to check first.
 *
 * Note this is the one scoped tool that changes state, so readOnlyHint is
 * false on it in the registration.
 */
import type { Config, Context } from '@netlify/functions';
import { formatSlot } from '../../src/lib/business';
import { findHold, isLive, setHoldStatus } from '../../src/lib/schedule';
import { ok, refuse, readJson, str } from '../../src/lib/respond';

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
      'Check the reference against what book_appointment returned.',
      { reference }
    );
  }

  const { hold, date } = found;

  if (hold.status === 'cancelled') {
    return refuse(
      'ALREADY_CANCELLED',
      `Booking ${hold.ref} was already cancelled, so there is nothing to undo.`,
      'Tell the customer it is already cancelled and offer to find a different window.',
      { reference: hold.ref }
    );
  }

  if (hold.status === 'declined') {
    return refuse(
      'ALREADY_DECLINED',
      `Booking ${hold.ref} was already declined by the owner, so it was never on the schedule.`,
      'Offer to check availability again and book a different window.',
      { reference: hold.ref }
    );
  }

  // A confirmed job is a commitment the owner has made and possibly driven
  // toward. Cancelling that is a phone call, not an API call.
  if (hold.status === 'confirmed') {
    return refuse(
      'ALREADY_CONFIRMED',
      `Booking ${hold.ref} is already confirmed for ${formatSlot(hold.slot)} on ${date}. Confirmed jobs cannot be cancelled by an assistant.`,
      'Ask the customer to call the shop on (253) 555-0142 to move or cancel a confirmed appointment.',
      { reference: hold.ref, phone: '(253) 555-0142' }
    );
  }

  if (!isLive(hold)) {
    return refuse(
      'HOLD_EXPIRED',
      `Hold ${hold.ref} already expired, so the ${formatSlot(hold.slot)} window on ${date} is open again.`,
      'Nothing needs cancelling. Offer to book a window again if the customer still wants one.',
      { reference: hold.ref }
    );
  }

  const result = await setHoldStatus(date, hold.ref, 'cancelled');
  if (!result.ok) {
    return refuse(
      result.reason,
      'We could not cancel that hold just now because the schedule changed underneath us.',
      'Call check_hold_status to see where it landed, then try again if it is still pending.',
      { reference: hold.ref }
    );
  }

  return ok({
    reference: hold.ref,
    status: 'cancelled',
    date,
    slot: hold.slot,
    window: formatSlot(hold.slot),
    message: `Cancelled ${hold.ref}. The ${formatSlot(hold.slot)} window on ${date} is open again and the owner will not be expecting anyone.`,
    next: 'Confirm to the customer that it is cancelled. If they want a different time, check availability again.',
  });
};

export const config: Config = { path: '/api/cancel-hold' };
