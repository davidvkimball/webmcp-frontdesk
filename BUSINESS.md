# The business

Canonical facts for Clarks Creek Plumbing. **Every tool response, every page of site copy, and every fixture in `netlify/functions` reads from this file.** If a number appears in two places and they disagree, this file wins and the other one is a bug. A judge comparing the site against a tool response is exactly the check that catches a thrown-together entry, so consistency here is worth more than it looks.

Decided 2026-08-25. The business is invented. See the disclosure rules below, which are not optional.

---

## 1. Identity

- **Name:** Clarks Creek Plumbing
- **Owner:** Dale Whitcomb, journeyman plumber, running the business since 2009
- **Size:** three people and two vans. Dale, one journeyman, one apprentice. **No office staff and no answering service.** This is the whole thesis, so it belongs in the About copy in plain words
- **Base:** Puyallup, Washington 98371
- **No street address.** Mobile business, no storefront, no public address. This is genuinely how many small trades operate, and it avoids inventing an address that lands on a real person's house
- **Phone (displayed):** (253) 555-0142. Area code 253 is really Pierce County. The 555-0100 through 555-0199 block is reserved for fiction, so this can be printed anywhere without dialling a stranger
- **Contact path:** the website contact form, which is the one carrying the declarative WebMCP annotation. No public email address, because any address we print either bounces or is not ours

Clarks Creek is a real creek running through Puyallup. The name reads local and specific the way a real trade business does. Checked against BBB, Yelp and Yellow Pages listings for Puyallup on 2026-08-25 and no business by this name came up.

## 2. Disclosure, and the licence number

The site carries a visible line, in the footer and on the About page, in the site's own voice rather than fine print:

> Clarks Creek Plumbing is a demonstration business built for the WebMCP challenge. The tools on this site are real and working. The plumber is not.

The licence number is the trap. Washington genuinely requires contractor registration, and a plausible fake in the real L&I format would be a fake licence presented as real, which the house rules forbid outright. So:

- **Licence number is `DEMO-WA-0000000`**, deliberately not in the real Washington format
- `describe_services` returns it as a structured object with the disclaimer attached, never as a bare string:

```json
"license": {
  "number": "DEMO-WA-0000000",
  "state": "WA",
  "note": "Demonstration business built for the WebMCP challenge. Not a real contractor registration."
}
```

A judge who calls that tool sees us being straight with them. That is worth more than a number that looks convincing for four seconds.

## 3. Service area

Base point is downtown Puyallup, 47.1854 N, -122.2929 W. `check_service_area` is straight-line distance from that point, which is pure math with no state and no API key.

| Tier | Straight-line distance | Travel fee | Behaviour |
|---|---|---|---|
| Core | 0 to 10 miles | none | Books normally |
| Extended | 10 to 17 miles | $45 | Books, and the fee is stated up front in the tool response |
| Outside | over 17 miles | n/a | Refuses, and names the nearest covered city with its distance |

**These are straight-line miles, computed, not estimated.** Road distance runs roughly 1.3x to 1.5x higher, which is why the bands look tighter than a drive time would suggest. The earlier draft of this file used 12 and 20 miles based on road distances and was wrong: Federal Way is 9.5 straight-line miles from Puyallup, not the 14 the road sign says, which would have put it in the wrong band.

**Core, all within 10 miles:** Puyallup, Sumner, South Hill, Edgewood, Milton, Fife, Bonney Lake, Orting, Tacoma, Spanaway, Auburn, Graham, Federal Way
**Extended, 10 to 17 miles:** Lakewood, University Place, Buckley, Kent, Enumclaw, Steilacoom, Gig Harbor
**Outside:** Burien, Renton, Eatonville, Seattle, Bellevue, Olympia, Everett, and anything further

There is no geocoding API. `check_service_area` matches a ZIP or a city name against a lookup table in `src/lib/business.ts` and measures great-circle distance from the base point. An address it cannot place gets an honest refusal asking for a city or ZIP, rather than a confident wrong answer. An API key here would be a dependency, a failure mode and a rate limit, in the one tool that gets called first in nearly every chain.

The refusal is a real answer, not an error, and it names the nearest covered town measured **from the customer**, not from us:

> Seattle is about 29 miles from Puyallup, which is outside our service area. The nearest place we do cover is Kent, roughly 16 miles from there.

## 4. Hours

- Monday to Friday, 7:00am to 6:00pm
- Saturday, 8:00am to 2:00pm
- Sunday closed for scheduled work
- **Emergencies 24/7** for an active leak, no water, or a sewage backup. Nothing else counts as an emergency, and `check_availability` should say so rather than quietly widening the definition

Appointment slots are two hours wide. Standard slots start on the hour from 8:00am, last standard start is 4:00pm weekdays and noon Saturday.

## 5. Services and price ranges

`estimate_job` returns a **range** and always attaches the note that the final price comes after someone sees the job. Honest ranges beat fake precision, and this is the tool most likely to be quoted in the demo video.

| Job | Range |
|---|---|
| Drain clearing | $185 to $375 |
| Water heater replacement, tank, 40 to 50 gallon | $1,650 to $2,900 |
| Tankless water heater install | $3,800 to $6,500 |
| Toilet replacement | $425 to $780 |
| Leak diagnosis and repair | $250 to $900 |
| Sump pump replacement | $850 to $1,800 |
| Whole house repipe, PEX | $6,500 to $14,000 |

- **Diagnostic fee $89**, waived if the repair happens on the same visit
- **After-hours emergency callout $195**, applied to the repair
- Travel fee $45 in the extended area only

## 6. The owner's phone

The number on the site is fictional. The number Twilio texts when a booking is held is David's real cell, held in a Netlify environment variable and **never rendered anywhere on the site or returned by any tool**. Those two facts must not get confused, because one of them is public and the other is in a public repo's deploy settings.
