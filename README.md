# Clarks Creek Plumbing

A working website for a small plumbing business that exposes real tools an AI agent can call, built for the [OpenAI WebMCP Challenge](https://webmcp.devpost.com/).

**Live site:** https://clarks-creek-plumbing.netlify.app

> Clarks Creek Plumbing is a fictional demonstration business created for the WebMCP Challenge. No real plumbing services are offered, no real customer data is used, and the licence number is a deliberate placeholder rather than a real Washington contractor registration. The tools are real and working. The plumber is not.

## What this is

A three-person plumbing business has no receptionist. The owner is under a house for most of the working day and cannot answer his phone. Agents are becoming how people find local help, and today an agent that finds his website can read it and nothing else. It hands the customer a phone number, the customer calls somebody else, and he never learns the job existed.

This site gives an agent something to actually call. A customer talking to ChatGPT can confirm the plumber covers their address, see genuine open appointment slots, get a price range, and book a visit. The owner gets a text message and confirms by replying with one word.

## Why WebMCP fits

Large businesses will build agent integrations. Small businesses never will. There is no budget, no engineer, and no appetite for another platform to log into.

WebMCP is interesting here precisely because the capability rides on the website the business already has. No app, no public API, no CRM, no booking platform, no receptionist. A page that was previously readable becomes callable, and the long tail of local service businesses that are structurally invisible to agents today become participants in it.

The plumber is the proof case, not the product. The same shape applies to electricians, HVAC, locksmiths, appliance repair, mobile mechanics, cleaners, tutors and groomers: trades where service area, availability, and human judgment are exactly the things worth exposing.

## The tools

| Tool | Purpose | Read-only |
|---|---|---|
| `check_service_area` | Does the plumber drive to this address, and does it add a travel fee | Yes |
| `check_availability` | Real open appointment windows for a service and date | Yes |
| `estimate_job` | A price range, with the honest caveat that the real number comes after someone looks | Yes |
| `describe_services` | Services, hours, service area, emergency policy, licence disclosure | Yes |
| `book_appointment` | Holds a slot, texts the owner, returns a pending confirmation | No |

Currently implemented: `check_service_area`. The rest land over the build.

Two design decisions worth calling out.

**Tools refuse, in a shape the agent can act on.** Every failure returns a stable reason code, a sentence written for a person, and a suggested next action. The interesting property of an agent-native interface is not that the site can do things, it is that the site can say precisely what it cannot do and what would work instead.

```json
{
  "ok": false,
  "reason": "OUTSIDE_SERVICE_AREA",
  "message": "Seattle is about 29.1 miles from Puyallup, which is outside our service area. The nearest place we do cover is Kent, roughly 16.2 miles from there.",
  "next": "Tell the customer we cannot reach them, and offer to check a different address if the job is somewhere else."
}
```

**A human stays in the loop on purpose.** `book_appointment` does not silently commit the owner's calendar. It holds the slot, texts him, and confirms only when he replies. This is a deliberate trust boundary rather than a missing feature: the agent can negotiate and prepare the transaction, and the person who owns the week decides whether it happens.

## How it is implemented

```
ChatGPT (or any WebMCP agent)
   |
   |  document.modelContext.registerTool(...)
   v
clarks-creek-plumbing.netlify.app
   |
   +-- check_service_area  --> /api/service-area   (pure math, no state)
   +-- check_availability  --> /api/availability   --> Netlify Blobs
   +-- estimate_job        --> /api/estimate       (pricing rules, no state)
   +-- describe_services   --> /api/services
   +-- book_appointment    --> /api/book           --> Netlify Blobs
                                                    --> Twilio --> owner's phone
                                                                     |
                                              /api/confirm  <--  "YES"
```

- **Astro 7** static site, deployed on Netlify
- **Netlify Functions** behind every tool
- **Netlify Blobs** for the schedule and pending holds. No external database
- **Twilio** for owner and customer SMS, credentials in environment variables only

Details that matter for a correct WebMCP implementation:

- `execute` returns a **string**, so structured results are stringified
- The `AbortSignal` handed to `execute` is passed into every `fetch`, so a cancelled agent request cancels the network call rather than leaving it running
- Tools are registered on `astro:page-load` and torn down on `astro:before-swap` through an `AbortController`, because the site uses Astro's client router and a plain script would go stale across navigations
- `readOnlyHint` is set only on tools that genuinely change nothing. Marking a state-changing tool read-only is not an optimisation, it is a claim the browser acts on by skipping a confirmation it should have shown
- No geocoding API. Service area resolves a city or ZIP against a lookup table and measures great-circle distance, because an API key in the tool that gets called first in every chain is a dependency, a rate limit, and an outage that is not our fault

## Running it locally

Requires Node 22.12 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

That serves the site, but the tool backends are Netlify Functions, so to exercise the tools end to end use:

```bash
pnpm dev:netlify
```

Copy `.env.example` to `.env` and fill in Twilio credentials if you want the SMS path to work. Everything else runs without configuration.

To call a tool backend directly, without an agent:

```bash
curl -X POST http://localhost:8888/api/service-area -H 'content-type: application/json' -d '{"location":"Gig Harbor"}'
```

## Testing with an agent

- **ChatGPT's in-app browser** works with no setup. This is the target surface
- **Chrome 149+** with `chrome://flags/#enable-webmcp-testing` enabled, then relaunch
- The Model Context Tool Inspector extension is useful for confirming registration

## Licence

MIT. See [LICENSE](./LICENSE).

Twilio is used under its own terms of service. No third-party trademarks, photography, reviews, or business identities appear in this project.
