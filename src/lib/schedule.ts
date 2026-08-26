/**
 * Schedule state, in Netlify Blobs.
 *
 * Two things here are correctness-critical and both are easy to get wrong:
 *
 * 1. **Strong consistency.** Blobs default to eventual consistency and
 *    propagate writes over roughly 60 seconds. Availability that is a minute
 *    stale is worse than useless, because it hands an agent a slot that is
 *    already gone. Every read in this file opts into strong consistency.
 *
 * 2. **Conditional writes.** Overlapping plain writes are last-write-wins with
 *    no concurrency control, which means two agents can book the same slot.
 *    Holds are taken with onlyIfMatch against the ETag we read, and a
 *    modified:false result means somebody beat us to it. That is a refusal,
 *    not an error.
 */
import { getStore } from '@netlify/blobs';

/** A hold with no owner reply expires, so an abandoned chat cannot freeze a slot. */
export const HOLD_TTL_MINUTES = 30;

export type Hold = {
  ref: string;
  slot: string;
  service: string;
  status: 'held' | 'confirmed' | 'declined' | 'cancelled';
  customerName: string;
  /** Needed so the confirm webhook can text the customer back. Never returned by a tool. */
  customerPhone: string;
  createdAt: string;
  expiresAt: string;
};

export type Day = { date: string; holds: Hold[] };

const store = () => getStore({ name: 'schedule', consistency: 'strong' });
const keyFor = (date: string) => `day/${date}`;

export function isLive(hold: Hold, now = Date.now()): boolean {
  if (hold.status === 'declined' || hold.status === 'cancelled') return false;
  if (hold.status === 'confirmed') return true;
  return Date.parse(hold.expiresAt) > now;
}

/** Read a day plus its ETag, so a later write can be made conditional on it. */
export async function readDay(date: string): Promise<{ day: Day; etag: string | null }> {
  const result = await store().getWithMetadata(keyFor(date), { type: 'json' });
  if (!result) return { day: { date, holds: [] }, etag: null };
  return { day: (result.data as Day) ?? { date, holds: [] }, etag: result.etag ?? null };
}

/** Slots that are genuinely spoken for right now, expired holds excluded. */
export async function takenSlots(date: string): Promise<Set<string>> {
  const { day } = await readDay(date);
  const now = Date.now();
  return new Set(day.holds.filter((h) => isLive(h, now)).map((h) => h.slot));
}

export type HoldResult =
  | { ok: true; hold: Hold }
  | { ok: false; reason: 'SLOT_TAKEN' | 'WRITE_RACE' };

/**
 * Take a hold on a slot. Safe against a concurrent booking of the same slot:
 * the write only lands if the day has not changed since we read it, and a
 * losing writer retries against fresh state rather than clobbering.
 */
export async function takeHold(
  date: string,
  slot: string,
  details: { service: string; customerName: string; customerPhone: string }
): Promise<HoldResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { day, etag } = await readDay(date);
    const now = Date.now();

    if (day.holds.some((h) => h.slot === slot && isLive(h, now))) {
      return { ok: false, reason: 'SLOT_TAKEN' };
    }

    const hold: Hold = {
      ref: reference(date, slot, attempt),
      slot,
      service: details.service,
      status: 'held',
      customerName: details.customerName,
      customerPhone: details.customerPhone,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + HOLD_TTL_MINUTES * 60_000).toISOString(),
    };

    const next: Day = {
      date,
      // Drop dead holds while we are here, so the document cannot grow forever.
      holds: [...day.holds.filter((h) => isLive(h, now)), hold],
    };

    const written = await store().setJSON(
      keyFor(date),
      next,
      etag ? { onlyIfMatch: etag } : { onlyIfNew: true }
    );

    if (written.modified) return { ok: true, hold };
    // Someone else wrote first. Re-read and try again against their version.
  }
  return { ok: false, reason: 'WRITE_RACE' };
}

function reference(date: string, slot: string, salt: number): string {
  const compact = date.replace(/-/g, '').slice(4) + slot.replace(':', '');
  const noise = Math.floor(Date.now() % 997) + salt;
  return `CCP-${compact}-${String(noise).padStart(3, '0')}`;
}

/**
 * Flip a hold's status, conditional on the day not having changed. Lives here
 * rather than in the webhook so that the `day/` key scheme and the Blobs store
 * name exist in exactly one file.
 */
export async function setHoldStatus(
  date: string,
  ref: string,
  status: Hold['status']
): Promise<{ ok: true; hold: Hold } | { ok: false; reason: 'HOLD_NOT_FOUND' | 'WRITE_RACE' }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { day, etag } = await readDay(date);
    const target = day.holds.find((h) => h.ref === ref);
    if (!target) return { ok: false, reason: 'HOLD_NOT_FOUND' };

    const updated: Hold = { ...target, status };
    const next: Day = { date, holds: day.holds.map((h) => (h.ref === ref ? updated : h)) };

    const written = await store().setJSON(
      keyFor(date),
      next,
      etag ? { onlyIfMatch: etag } : { onlyIfNew: true }
    );
    if (written.modified) return { ok: true, hold: updated };
  }
  return { ok: false, reason: 'WRITE_RACE' };
}

/** Every day key currently in the store, newest first. */
export async function listDayKeys(): Promise<string[]> {
  const { blobs } = await store().list({ prefix: 'day/' });
  return blobs.map((b) => b.key.slice('day/'.length)).sort().reverse();
}

/**
 * Find a hold by its reference, without the caller needing to know the date.
 * An agent holding a reference from earlier in a conversation has no reason to
 * still be holding the date, so asking for both would be a needless refusal.
 */
export async function findHold(ref: string): Promise<{ hold: Hold; date: string } | null> {
  const wanted = String(ref || '').trim().toUpperCase();
  if (!wanted) return null;
  for (const date of await listDayKeys()) {
    const { day } = await readDay(date);
    const hold = day.holds.find((h) => h.ref.toUpperCase() === wanted);
    if (hold) return { hold, date };
  }
  return null;
}
