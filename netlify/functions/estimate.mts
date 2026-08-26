/**
 * Backend for the estimate_job WebMCP tool.
 *
 * Returns a range and says plainly that the real number comes after someone
 * looks at it. Fake precision from a tool an agent will quote verbatim is the
 * fastest way to make a business look dishonest.
 */
import type { Config, Context } from '@netlify/functions';
import { HOURS, SERVICES, resolveService, looksLikeEmergency } from '../../src/lib/business';
import { ok, refuse, readJson, str } from '../../src/lib/respond';

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return refuse('METHOD_NOT_ALLOWED', 'Send a POST request with a JSON body.', 'Retry as POST.', {}, 405);
  }
  const body = await readJson(req);
  if (!body) {
    return refuse('INVALID_REQUEST', 'That request body was not valid JSON.', 'Retry with {"job": "water heater"}.', {}, 400);
  }

  const job = str(body.job) || str(body.service);
  const details = str(body.details);

  if (!job) {
    return refuse(
      'MISSING_JOB',
      'No job description was provided.',
      'Ask the customer what is actually wrong, in their own words, then call this tool again.'
    );
  }

  const service = resolveService(`${job} ${details}`);
  if (!service) {
    return refuse(
      'UNKNOWN_SERVICE',
      `We could not match "${job}" to something we quote. We handle drains, water heaters, toilets, leaks, sump pumps and repipes.`,
      'Ask the customer to describe the symptom, for example a clogged drain or no hot water, then call this tool again. If it is genuinely none of these, say we would need to hear about it directly.',
      { quotable: SERVICES.map((s) => s.label) }
    );
  }

  const emergency = looksLikeEmergency(`${job} ${details}`);

  return ok({
    service: service.label,
    estimateUsd: { low: service.low, high: service.high },
    message:
      `${service.label} usually runs $${service.low.toLocaleString()} to $${service.high.toLocaleString()}. ` +
      `That is a range, not a quote: the final price depends on what we find when we get there.` +
      (emergency
        ? ` This sounds like an emergency, so if it is outside normal hours there is also a $${HOURS.emergencyCalloutUsd} after-hours callout, which comes off the repair.`
        : ` There is an $${HOURS.diagnosticUsd} diagnostic fee, waived if we do the repair on the same visit.`),
    diagnosticFeeUsd: HOURS.diagnosticUsd,
    diagnosticWaivedWithRepair: true,
    afterHoursCalloutUsd: emergency ? HOURS.emergencyCalloutUsd : null,
    looksLikeEmergency: emergency,
    typicalWindows: service.slots,
    next: 'If the customer wants to go ahead, check the service area and then availability.',
  }, 300);
};

export const config: Config = { path: '/api/estimate' };
