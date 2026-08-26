/**
 * Smoke test against a deployed site.
 *
 *   node scripts/smoke.mjs                        # against production
 *   node scripts/smoke.mjs http://localhost:8888  # against netlify dev
 *   node scripts/smoke.mjs --book                 # include the booking path
 *
 * The booking path is opt in because it writes a real hold AND messages the
 * owner's actual phone. Running it casually means buzzing a real person, so it
 * takes a deliberate flag.
 */

const args = process.argv.slice(2);
const book = args.includes('--book');
const base = (args.find((a) => !a.startsWith('--')) ?? 'https://clarks-creek-plumbing.netlify.app').replace(/\/$/, '');

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
  }
}

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 120) };
  }
}

/** A weekday far enough out that a stale hold from an earlier run is unlikely. */
function weekdayAhead(days) {
  const d = new Date(Date.now() + days * 86400000);
  while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

console.log(`\nSmoke test against ${base}\n`);

console.log('pages');
for (const path of ['/', '/about/', '/services/', '/service-area/', '/contact/', '/thank-you/', '/dispatch/']) {
  const res = await fetch(base + path);
  check(`${path} responds 200`, res.status === 200, `got ${res.status}`);
}

console.log('\nthe repo requirements');
const home = await (await fetch(base + '/')).text();
check('no starter placeholder copy survives', !/lilAgents Astro starter|Replace this content|REPLACE_ME/i.test(home));
check('demo disclosure is on the page', /demonstration business/i.test(home));

console.log('\ncheck_service_area');
let r = await post('/api/service-area', { location: '98371' });
check('covers a home ZIP', r.json?.ok === true && r.json?.tier === 'core');
r = await post('/api/service-area', { location: 'Gig Harbor' });
check('extended area carries a travel fee', r.json?.ok === true && r.json?.travelFeeUsd === 45);
r = await post('/api/service-area', { location: 'Seattle' });
check('refuses out of area with a nearest town', r.json?.reason === 'OUTSIDE_SERVICE_AREA' && !!r.json?.nearestCovered?.city);
r = await post('/api/service-area', { location: 'Narnia' });
check('refuses an unknown place rather than guessing', r.json?.reason === 'LOCATION_NOT_RECOGNISED');

console.log('\ncheck_availability');
r = await post('/api/availability', { date: weekdayAhead(3) });
check('returns bookable windows', r.json?.ok === true && Array.isArray(r.json?.slots) && r.json.slots.length > 0);
r = await post('/api/availability', { date: '2020-01-01' });
check('refuses a date in the past', r.json?.reason === 'DATE_IN_PAST');
r = await post('/api/availability', { date: 'next tuesday' });
check('refuses an unparseable date', r.json?.reason === 'INVALID_DATE');

console.log('\nestimate_job');
r = await post('/api/estimate', { job: 'no hot water' });
check('prices a known job as a range', r.json?.ok === true && r.json?.estimateUsd?.low < r.json?.estimateUsd?.high);
r = await post('/api/estimate', { job: 'rewire the house' });
check('refuses work we do not do', r.json?.reason === 'UNKNOWN_SERVICE');

console.log('\ndescribe_services');
r = await post('/api/services', {});
check('returns the licence as a structured object', typeof r.json?.license === 'object' && !!r.json?.license?.note);
check('licence is flagged as a demonstration', /demonstration/i.test(r.json?.license?.note ?? ''));

console.log('\nconversation scoped tools');
r = await post('/api/hold-status', { reference: 'CCP-FAKE-000' });
check('hold-status refuses an unknown reference', r.json?.reason === 'HOLD_NOT_FOUND');
r = await post('/api/cancel-hold', { reference: 'CCP-FAKE-000' });
check('cancel-hold refuses an unknown reference', r.json?.reason === 'HOLD_NOT_FOUND');
r = await post('/api/hold-status', {});
check('hold-status refuses a missing reference', r.json?.reason === 'MISSING_REFERENCE');

console.log('\ndispatch board feed');
const sched = await (await fetch(base + '/api/schedule')).json();
check('schedule returns ten days', Array.isArray(sched?.days) && sched.days.length === 10);
check('schedule reports counts', typeof sched?.counts?.open === 'number');
check('no customer phone number is ever exposed', !/\+1\d{10}|\d{3}-\d{3}-\d{4}/.test(JSON.stringify(sched)));

if (book) {
  console.log('\nbooking, which messages a real phone');
  const date = weekdayAhead(6);
  const made = await post('/api/book', {
    name: 'Smoke Test',
    phone: '253-555-0101',
    address: 'Puyallup WA',
    service: 'clogged drain',
    date,
    slot: '16:00',
  });
  const ref = made.json?.reference;
  check('booking returns a held reference', made.json?.ok === true && made.json?.status === 'held' && !!ref);
  check('booking is not reported as confirmed', made.json?.confirmed === false);
  check('customer phone is not echoed back', !JSON.stringify(made.json).includes('555-0101'));

  if (ref) {
    const dup = await post('/api/book', { name: 'Second', phone: '253-555-0102', address: 'Puyallup WA', service: 'drain', date, slot: '16:00' });
    check('the same window cannot be booked twice', dup.json?.reason === 'SLOT_TAKEN');

    const status = await post('/api/hold-status', { reference: ref });
    check('hold-status finds it pending', status.json?.status === 'held');

    const cancelled = await post('/api/cancel-hold', { reference: ref });
    check('cancel releases the window', cancelled.json?.ok === true);

    const after = await post('/api/availability', { date });
    check('the window is open again', (after.json?.slots ?? []).some((s) => s.start === '16:00'));
  }
} else {
  console.log('\nbooking path skipped. Pass --book to include it. It messages a real phone.');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
