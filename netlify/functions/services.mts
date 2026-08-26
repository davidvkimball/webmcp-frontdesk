/**
 * Backend for the describe_services WebMCP tool.
 *
 * This is the tool an agent reaches for when the customer asks a general
 * question, so it answers everything at once. Making the model take four
 * round trips to learn what we do, what it costs, when we work and how far
 * we drive is the sort of thing that turns a good conversation into a slow
 * one, and none of this data is expensive to produce.
 *
 * Everything here is derived from src/lib/business.ts rather than restated,
 * including the service area lists, so a fact can only be wrong in one place.
 *
 * The licence is an object with its disclaimer attached and never a bare
 * string. A number on its own reads as a real Washington contractor
 * registration the moment it leaves this file, and this business is invented.
 */
import type { Config, Context } from '@netlify/functions';
import {
  AREA,
  BASE_POINT,
  BUSINESS,
  HOURS,
  PLACES,
  SERVICES,
  formatSlot,
  milesBetween,
} from '../../src/lib/business';
import { ok, refuse } from '../../src/lib/respond';

const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Split the known towns into bands by measuring them, rather than keeping a
 * second hand-maintained list that can drift away from the one the booking
 * path actually enforces.
 */
function serviceAreaBands() {
  const core: string[] = [];
  const extended: string[] = [];
  for (const [name, place] of Object.entries(PLACES)) {
    const miles = milesBetween(BASE_POINT, place);
    if (miles <= AREA.coreMiles) core.push(title(name));
    else if (miles <= AREA.extendedMiles) extended.push(title(name));
  }
  return { core: core.sort(), extended: extended.sort() };
}

const windowsFor = (weekday: number) =>
  (HOURS.slotStartsByWeekday[weekday] ?? []).map((start) => ({ start, window: formatSlot(start) }));

export default async (req: Request, _context: Context) => {
  // Read only and side effect free, so a GET is as valid as a POST. An agent
  // that guesses either way gets an answer instead of a 405.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return refuse(
      'METHOD_NOT_ALLOWED',
      'This tool answers GET and POST requests.',
      'Retry as GET, with no body needed.',
      {},
      405
    );
  }

  const bands = serviceAreaBands();

  return ok(
    {
      business: {
        name: BUSINESS.name,
        owner: BUSINESS.owner,
        base: BUSINESS.base,
        phone: BUSINESS.phone,
        established: BUSINESS.established,
        crew: BUSINESS.crew,
      },
      license: { ...BUSINESS.license },
      disclosure: BUSINESS.disclosure,
      services: SERVICES.map((service) => ({
        key: service.key,
        label: service.label,
        priceRangeUsd: { low: service.low, high: service.high },
        typicalArrivalWindows: service.slots,
        typicalDurationHours: service.slots * 2,
        alsoCalled: service.aliases,
      })),
      pricingNote:
        'Every figure here is a range. The final price is set once someone has actually seen the job, and we do not quote a single number over the phone.',
      fees: {
        diagnosticUsd: HOURS.diagnosticUsd,
        diagnosticNote: `The $${HOURS.diagnosticUsd} diagnostic fee is waived if the repair happens on the same visit.`,
        afterHoursCalloutUsd: HOURS.emergencyCalloutUsd,
        afterHoursNote: `An after hours emergency callout is $${HOURS.emergencyCalloutUsd}, and it goes toward the repair.`,
        extendedAreaTravelFeeUsd: AREA.travelFeeUsd,
      },
      hours: {
        timezone: HOURS.timezone,
        ...HOURS.display,
        arrivalWindowHours: 2,
        weekdayWindows: windowsFor(1),
        saturdayWindows: windowsFor(6),
      },
      emergencyPolicy: HOURS.emergency,
      serviceArea: {
        description: `We work out of ${BUSINESS.base}. Anything within ${AREA.coreMiles} straight line miles is covered with no travel fee, ${AREA.coreMiles} to ${AREA.extendedMiles} miles adds a $${AREA.travelFeeUsd} travel fee, and past ${AREA.extendedMiles} miles we do not come out.`,
        coreMiles: AREA.coreMiles,
        extendedMiles: AREA.extendedMiles,
        travelFeeUsd: AREA.travelFeeUsd,
        milesAreStraightLine: true,
        coreTowns: bands.core,
        extendedTowns: bands.extended,
      },
      message:
        `${BUSINESS.name} is a ${BUSINESS.crew} person plumbing shop in ${BUSINESS.base}, run by ${BUSINESS.owner} since ${BUSINESS.established}. ` +
        `We do ${SERVICES.map((s) => s.label.toLowerCase()).join(', ')}. ` +
        `${HOURS.display.weekdays}. ${HOURS.display.saturday}. Sunday is closed for scheduled work. ` +
        HOURS.emergency,
      next: 'Ask the customer what they are actually dealing with, then estimate the job or check a specific day for open arrival windows.',
    },
    // Static for the life of a deploy, so it is worth caching. Nothing here
    // depends on the schedule, which is the only thing that moves.
    300
  );
};

export const config: Config = { path: '/api/services' };
