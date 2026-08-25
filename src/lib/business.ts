/**
 * Clarks Creek Plumbing: the machine-readable business.
 *
 * This module is the implementation of BUSINESS.md and the two must agree.
 * It is imported by the Astro site AND by the Netlify Functions behind the
 * WebMCP tools, so a fact can only be wrong in one place at a time.
 *
 * Clarks Creek Plumbing is a fictional demonstration business built for the
 * WebMCP challenge. The tools are real. The plumber is not.
 */

export const BUSINESS = {
  name: 'Clarks Creek Plumbing',
  owner: 'Dale Whitcomb',
  base: 'Puyallup, Washington',
  phone: '(253) 555-0142',
  established: 2009,
  crew: 3,
  fictional: true,
  disclosure:
    'Clarks Creek Plumbing is a fictional demonstration business built for the WebMCP challenge. No real plumbing services are offered and no real customer data is used.',
  license: {
    number: 'DEMO-WA-0000000',
    state: 'WA',
    note: 'Demonstration business built for the WebMCP challenge. Not a real contractor registration.',
  },
} as const;

/** Downtown Puyallup. Every service-area distance is measured from here. */
export const BASE_POINT = { lat: 47.1854, lon: -122.2929 } as const;

/**
 * Service area bands, in straight-line miles from BASE_POINT.
 *
 * These are straight-line, not road miles, and the numbers were computed
 * rather than guessed. Road distance runs roughly 1.3x to 1.5x higher, which
 * is why the bands look tighter than a drive time would suggest.
 */
export const AREA = {
  coreMiles: 10,
  extendedMiles: 17,
  travelFeeUsd: 45,
} as const;

/**
 * Towns we can resolve without a geocoding API. Deliberately a lookup table:
 * an API key is a dependency, a failure mode, and a rate limit, and it buys
 * nothing a judge will see. An address we cannot resolve gets an honest
 * refusal asking for a city or ZIP rather than a wrong answer.
 */
export const PLACES: Record<string, { lat: number; lon: number; zips?: string[] }> = {
  'puyallup': { lat: 47.1854, lon: -122.2929, zips: ['98371', '98372', '98373', '98374', '98375'] },
  'south hill': { lat: 47.1379, lon: -122.2926 },
  'sumner': { lat: 47.2032, lon: -122.2407, zips: ['98390'] },
  'edgewood': { lat: 47.2493, lon: -122.2929, zips: ['98372'] },
  'milton': { lat: 47.2482, lon: -122.3126, zips: ['98354'] },
  'fife': { lat: 47.2398, lon: -122.3568, zips: ['98424'] },
  'bonney lake': { lat: 47.1771, lon: -122.1866, zips: ['98391'] },
  'orting': { lat: 47.0968, lon: -122.2043, zips: ['98360'] },
  'tacoma': { lat: 47.2529, lon: -122.4443, zips: ['98402', '98404', '98405', '98408', '98409'] },
  'spanaway': { lat: 47.1043, lon: -122.4346, zips: ['98387'] },
  'auburn': { lat: 47.3073, lon: -122.2285, zips: ['98001', '98002', '98092'] },
  'graham': { lat: 47.0526, lon: -122.2943, zips: ['98338'] },
  'federal way': { lat: 47.3223, lon: -122.3126, zips: ['98003', '98023'] },
  'lakewood': { lat: 47.1718, lon: -122.5185, zips: ['98499'] },
  'university place': { lat: 47.2354, lon: -122.5504, zips: ['98466'] },
  'buckley': { lat: 47.1631, lon: -122.0268, zips: ['98321'] },
  'kent': { lat: 47.3809, lon: -122.2348, zips: ['98030', '98031', '98032'] },
  'enumclaw': { lat: 47.2043, lon: -121.9915, zips: ['98022'] },
  'steilacoom': { lat: 47.1701, lon: -122.6029, zips: ['98388'] },
  'gig harbor': { lat: 47.3293, lon: -122.5799, zips: ['98335'] },
  'burien': { lat: 47.4704, lon: -122.3468, zips: ['98166'] },
  'renton': { lat: 47.4829, lon: -122.2171, zips: ['98055', '98057'] },
  'eatonville': { lat: 46.8687, lon: -122.2679, zips: ['98328'] },
  'seattle': { lat: 47.6062, lon: -122.3321, zips: ['98101', '98102', '98103', '98104', '98105'] },
  'bellevue': { lat: 47.6101, lon: -122.2015, zips: ['98004', '98005'] },
  'olympia': { lat: 47.0379, lon: -122.9007, zips: ['98501', '98502'] },
  'everett': { lat: 47.979, lon: -122.2021, zips: ['98201'] },
};

const EARTH_RADIUS_MILES = 3958.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in miles. */
export function milesBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/**
 * Best-effort resolution of a free-text location to a known place.
 * Matches a 5-digit ZIP anywhere in the string first, then a city name.
 * Returns null when it genuinely cannot tell, which is a refusal, not a guess.
 */
export function resolvePlace(input: string): { name: string; lat: number; lon: number } | null {
  const raw = String(input || '').toLowerCase().trim();
  if (!raw) return null;

  const zip = raw.match(/\b(\d{5})\b/)?.[1];
  if (zip) {
    for (const [name, place] of Object.entries(PLACES)) {
      if (place.zips?.includes(zip)) return { name: titleCase(name), ...place };
    }
  }

  // Longest name first, so "south hill" wins over a stray "hill".
  const names = Object.keys(PLACES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (raw.includes(name)) return { name: titleCase(name), ...PLACES[name] };
  }
  return null;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export type Coverage =
  | { covered: true; tier: 'core' | 'extended'; place: string; miles: number; travelFeeUsd: number }
  | { covered: false; reason: 'OUTSIDE_SERVICE_AREA'; place: string; miles: number; nearest: { name: string; miles: number } }
  | { covered: false; reason: 'LOCATION_NOT_RECOGNISED' };

/** The whole service-area decision, in one pure function with no I/O. */
export function coverageFor(location: string): Coverage {
  const place = resolvePlace(location);
  if (!place) return { covered: false, reason: 'LOCATION_NOT_RECOGNISED' };

  const miles = milesBetween(BASE_POINT, place);
  if (miles <= AREA.coreMiles) {
    return { covered: true, tier: 'core', place: place.name, miles, travelFeeUsd: 0 };
  }
  if (miles <= AREA.extendedMiles) {
    return { covered: true, tier: 'extended', place: place.name, miles, travelFeeUsd: AREA.travelFeeUsd };
  }

  // Name the closest place we actually cover, measured from THEM, not from us.
  let nearest = { name: '', miles: Infinity };
  for (const [name, candidate] of Object.entries(PLACES)) {
    if (milesBetween(BASE_POINT, candidate) > AREA.extendedMiles) continue;
    const away = milesBetween(place, candidate);
    if (away < nearest.miles) nearest = { name: titleCase(name), miles: away };
  }
  return { covered: false, reason: 'OUTSIDE_SERVICE_AREA', place: place.name, miles, nearest };
}
