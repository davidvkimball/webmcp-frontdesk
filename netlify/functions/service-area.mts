/**
 * Backend for the check_service_area WebMCP tool.
 *
 * Pure math over a lookup table: no state, no database, no third-party API,
 * so this endpoint cannot be slow, cannot be rate limited, and cannot be down
 * for a reason that is not our fault. That is deliberate. It is the first tool
 * an agent calls in almost every chain, so it is the worst possible place for
 * a dependency.
 */
import type { Config, Context } from '@netlify/functions';
import { AREA, BUSINESS, coverageFor } from '../../src/lib/business';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });

const round = (n: number) => Math.round(n * 10) / 10;

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return json(
      {
        ok: false,
        reason: 'METHOD_NOT_ALLOWED',
        message: 'Send a POST request with a JSON body containing a location.',
        next: 'Retry as POST.',
      },
      405
    );
  }

  let location = '';
  try {
    const body = (await req.json()) as { location?: unknown };
    location = typeof body.location === 'string' ? body.location : '';
  } catch {
    return json(
      {
        ok: false,
        reason: 'INVALID_REQUEST',
        message: 'That request body was not valid JSON.',
        next: 'Retry with a JSON body of the form {"location": "Puyallup, WA"}.',
      },
      400
    );
  }

  if (!location.trim()) {
    return json({
      ok: false,
      reason: 'MISSING_LOCATION',
      message: 'No location was provided.',
      next: 'Ask the customer which city or ZIP code the job is in, then call this tool again.',
    });
  }

  const result = coverageFor(location);

  if (!result.covered && result.reason === 'LOCATION_NOT_RECOGNISED') {
    return json({
      ok: false,
      reason: 'LOCATION_NOT_RECOGNISED',
      message: `We could not place "${location}". We cover the Puyallup area of Pierce County, Washington.`,
      next: 'Ask the customer for a city name or a 5 digit ZIP code, then call this tool again.',
    });
  }

  if (!result.covered) {
    return json({
      ok: false,
      reason: 'OUTSIDE_SERVICE_AREA',
      message:
        `${result.place} is about ${round(result.miles)} miles from Puyallup, which is outside our service area. ` +
        `The nearest place we do cover is ${result.nearest.name}, roughly ${round(result.nearest.miles)} miles from there.`,
      next: 'Tell the customer we cannot reach them, and offer to check a different address if the job is somewhere else.',
      location: result.place,
      milesFromBase: round(result.miles),
      nearestCovered: { city: result.nearest.name, milesAway: round(result.nearest.miles) },
    });
  }

  return json({
    ok: true,
    covered: true,
    location: result.place,
    milesFromBase: round(result.miles),
    tier: result.tier,
    travelFeeUsd: result.travelFeeUsd,
    message:
      result.tier === 'core'
        ? `Yes, we cover ${result.place}. It is about ${round(result.miles)} miles from our base in Puyallup and there is no travel fee.`
        : `Yes, we cover ${result.place}, but it is about ${round(result.miles)} miles out, which adds a $${AREA.travelFeeUsd} travel fee to the job.`,
    next: 'Ask what the problem is and when they need someone, then check availability.',
    business: { name: BUSINESS.name, disclosure: BUSINESS.disclosure },
  });
};

export const config: Config = {
  path: '/api/service-area',
};
