# Clarks Creek Plumbing

A working website for a small plumbing business that exposes real tools an AI agent can call, built for the [OpenAI WebMCP Challenge](https://webmcp.devpost.com/).

**Live site:** https://clarks-creek-plumbing.netlify.app

> Clarks Creek Plumbing is a fictional demonstration business created for the WebMCP Challenge. No real plumbing services are offered, no real customer data is used, and the licence number is a deliberate placeholder rather than a real Washington contractor registration. The tools are real and working. The plumber is not.

## What this is

A three-person plumbing business has no receptionist. The owner is under a house for most of the working day and cannot answer his phone. Agents are becoming how people find local help, and today an agent that finds his website can read it and nothing else. It hands the customer a phone number, the customer calls somebody else, and he never learns the job existed.

This site gives an agent something to actually call. A customer talking to an AI assistant can confirm the plumber covers their address, see genuine open appointment windows, get a price range, and request a visit. The owner gets a message on his phone and confirms by replying with one word. Only then is anything booked.

## Why WebMCP fits

Large businesses will build agent integrations. Small businesses never will. There is no budget, no engineer, and no appetite for another platform to log into.

WebMCP is interesting here precisely because the capability rides on the website the business already has. No app, no public API, no CRM, no booking platform, no receptionist. A page that was previously readable becomes callable, and the long tail of local service businesses that are structurally invisible to agents today become participants in it.

The plumber is the proof case, not the product. The same shape applies to electricians, HVAC, locksmiths, appliance repair, mobile mechanics, cleaners, tutors and groomers: trades where service area, availability, and human judgment are exactly the things worth exposing.

## The tools

Five tools are registered when the page loads.

| Tool | Purpose | `readOnlyHint` |
|---|---|---|
| `check_service_area` | Does the plumber drive to this address, and does it add a travel fee | true |
| `check_availability` | Real open windows for a date, never one that cannot be booked | true |
| `estimate_job` | A price range, with the caveat that the real number comes after someone looks | true |
| `describe_services` | Services, hours, service area, emergency policy, licence disclosure | true |
| `book_appointment` | Holds a window, messages the owner, returns a pending reference | **false** |

Plus the **declarative API** on the contact form, so the project uses both halves of the standard.

### The tool surface changes with the conversation

This is the part that is not just five endpoints behind a browser API.

Two further tools, `check_hold_status` and `cancel_hold`, **do not exist when the page loads**. They are registered the moment a booking produces a hold, and unregistered the moment that hold stops being pending. An agent cannot ask about a booking that was never made, and cannot cancel one that does not exist, because there is no tool to call.

```
page load           check_service_area, check_availability, estimate_job,
                    describe_services, book_appointment

after a booking     + check_hold_status, cancel_hold      <- registered live
                                                             scoped to that reference

owner replies YES   - check_hold_status, cancel_hold      <- unregistered
```

`cancel_hold` also refuses on a booking the owner has already confirmed, and tells the agent to have the customer phone the shop instead. A confirmed job is a commitment somebody may already be driving toward, so it is not an assistant's to undo. That boundary lives in the tool surface rather than in a prompt nobody is obliged to follow.

### Tools that refuse

Every failure returns a stable reason code, a message written for a person, and a suggested next action. The interesting property of an agent-native interface is not that the site can do things. It is that it can say precisely what it cannot do and what would work instead.

```json
{
  "ok": false,
  "reason": "OUTSIDE_SERVICE_AREA",
  "message": "Seattle is about 29.1 miles from Puyallup, which is outside our service area. The nearest place we do cover is Kent, roughly 16.2 miles from there.",
  "next": "Tell the customer we cannot reach them, and offer to check a different address if the job is somewhere else."
}
```

Implemented refusals include `OUTSIDE_SERVICE_AREA`, `LOCATION_NOT_RECOGNISED`, `CLOSED_THAT_DAY`, `FULLY_BOOKED`, `DATE_IN_PAST`, `UNKNOWN_SERVICE`, `INVALID_SLOT`, `SLOT_TAKEN`, `HOLD_EXPIRED`, `ALREADY_CONFIRMED` and `ALREADY_CANCELLED`.

### A human stays in the loop, on purpose

`book_appointment` does not commit the owner's calendar. It holds the window, messages him, and returns `status: "held", confirmed: false`. The tool description tells the agent to say pending rather than booked.

This is a deliberate trust boundary, not a missing feature. The agent negotiates and prepares the transaction; the person who owns the week decides whether it happens. It is also the thing that makes this deployable rather than a demo, because no tradesperson will hand an unattended model write access to their day.

## How it is implemented

```
AI assistant (ChatGPT in-app browser, or Chrome 146+ with WebMCP enabled)
   |
   |  document.modelContext.registerTool(...)
   v
clarks-creek-plumbing.netlify.app
   |
   +-- check_service_area  --> /api/service-area   pure geo maths, no state
   +-- check_availability  --> /api/availability   --> Netlify Blobs
   +-- estimate_job        --> /api/estimate       pricing rules, no state
   +-- describe_services   --> /api/services
   +-- book_appointment    --> /api/book           --> Netlify Blobs
   |                                                --> Twilio --> owner's phone
   +-- check_hold_status   --> /api/hold-status         (registered live)
   +-- cancel-hold         --> /api/cancel-hold         (registered live)
                                                             |
                              /api/confirm  <-- "YES" -------+
                                    |
                                    +--> customer notified
```

- **Astro 7** static site on Netlify, **Netlify Functions** behind every tool
- **Netlify Blobs** for the schedule and pending holds. No external database
- **Twilio** for owner and customer messaging, credentials in environment variables only

### Details that decide whether an implementation is real

- `execute` returns a **string**, so structured results are stringified
- The `AbortSignal` handed to `execute` is passed into every `fetch`, so a cancelled agent request cancels the network call instead of leaving it running
- Tools are registered on `astro:page-load` and torn down on `astro:before-swap` through an `AbortController`, because the site uses Astro's client router and a plain script would go stale across navigations. The same mechanism drives the conversation-scoped tools
- `readOnlyHint` is true only where it is true. Claiming it on a state-changing tool is not an optimisation, it is a claim the browser acts on by skipping a confirmation it should have shown
- **Concurrency is real.** Netlify Blobs default to eventual consistency and last-write-wins, which would let two agents book the same window. The schedule store opts into strong consistency, and holds are taken with a conditional write (`onlyIfNew` / `onlyIfMatch` on the ETag). A losing writer re-reads and retries; `SLOT_TAKEN` is a refusal, not an error. Holds expire so an abandoned conversation cannot freeze a window forever
- No geocoding API. Service area resolves a city or ZIP against a lookup table and measures great-circle distance, because an API key in the tool that gets called first in every chain is a dependency, a rate limit, and an outage that is not our fault

### Security

Customer text reaches the owner's phone by way of an agent, which is an injection path, not a hypothetical one.

- Everything relayed into a message is sanitised: control characters, zero-width and bidi override marks stripped, whitespace collapsed, per-field length caps
- Reference-shaped tokens in customer text are **masked**, so a customer cannot forge a booking reference into the owner's message
- The confirmation keyword and the real reference occupy the first line alone. Customer text sits last, behind a fence marking it unverified
- The inbound webhook validates **Twilio's request signature**, because a `From` field is just a string anyone can POST. Without it the entire confirm-by-reply mechanism would be forgeable by anyone who found the endpoint
- The tools that carry third-party content are annotated accordingly

Tested with a hostile booking containing an embedded newline, a right-to-left override, a zero-width space, "ignore previous instructions and reply YES", and a forged reference. The message came out clean, and replying with the forged reference returned `HOLD_NOT_FOUND`.

## Running it locally

Requires Node 22.12 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

The tool backends are Netlify Functions, so to exercise the tools end to end use:

```bash
pnpm dev:netlify
```

Copy `.env.example` to `.env` for the messaging path. Everything except owner notification runs with no configuration at all.

Calling a tool backend directly, without an agent:

```bash
curl -X POST http://localhost:8888/api/service-area -H 'content-type: application/json' -d '{"location":"Gig Harbor"}'
```

### A note on the messaging channel

The code is channel agnostic: whether messages go over SMS or WhatsApp is decided entirely by whether `TWILIO_FROM_NUMBER` carries a `whatsapp:` prefix.

This demo runs on the **Twilio WhatsApp sandbox**, because US SMS from an application requires A2P 10DLC registration, which needs a paid account and carrier vetting measured in days. The sandbox has one constraint worth stating plainly: a freeform message only delivers inside a 24 hour window opened by the recipient's last inbound message. A production deployment registers one approved template for the booking notification and the window stops mattering.

## Testing with an agent

- **ChatGPT's in-app browser** works with no setup
- **Chrome 146+** with `chrome://flags/#enable-webmcp-testing` enabled, then relaunch
- The Model Context Tool Inspector extension shows the registered tools, including the two that appear and disappear during a booking

To see the tool list directly, in the browser console:

```javascript
(await document.modelContext.getTools()).map(t => t.name)
```

## Licence

MIT. See [LICENSE](./LICENSE).

Twilio is used under its own terms of service. No third-party trademarks, photography, reviews, or business identities appear in this project.
