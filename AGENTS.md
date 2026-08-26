# webmcp-frontdesk

A WebMCP entry for the OpenAI and Netlify challenge, due **Thursday 3 September, 1:00 PM PT**.

**Read [BUSINESS.md](./BUSINESS.md) first.** It holds every fact about the demonstration business, and the site copy and the tool responses must both match it. This file is only the working rules.

## What this is

A working website for a local plumbing business that exposes real tools an AI agent can call, so a customer talking to ChatGPT can check the service area, check availability, get an estimate, and book a real appointment. The owner gets a text and confirms with one word.

The thesis: agents are becoming how people find local help, and today an agent that finds a plumber's site can read it and nothing else. We are not making shopping easier, we are making an unreachable person reachable.

## Stack

Follow `lilagents-team/web-pipeline` (`SKILL.md` is the authority) and start from `lilagents-team/astro-starter`.

- **Astro 7.x**, pnpm, **Node 22**, single `netlify.toml`
- **Netlify Functions** for every tool backend
- **Netlify Blobs** for schedule and hold state. No external database
- **Twilio** for owner and customer SMS, credentials in Netlify env vars only
- Images through the Astro image pipeline

## Hard rules

These are lilAgents house rules and they apply here even though this is a hackathon.

- **No hover scale or grow effects. Anywhere.** No `hover:scale-*`, `group-hover:scale-*`, `active:scale-*`, `whileHover` scale, or `transform: scale()` under any hover state. Use colour, background, border, opacity or shadow
- **External links get `target="_blank"` and no `rel` attribute at all.** Not `noopener`, not `noreferrer`, not `nofollow`
- **No em dashes**, in copy, comments, commit messages, or the README
- `prefers-reduced-motion` always has a working fallback
- No lorem ipsum, no stock photos standing in for a real business, no invented licence numbers presented as real
- **pnpm, never npm**

## WebMCP specifics

Verified against Chrome's docs on 2026-08-25. The standard is weeks old, so check rather than remember.

- `execute` **returns a string**. `JSON.stringify` anything structured
- Second argument to `execute` is `{ signal }`, an `AbortSignal`. **Pass it into every `fetch`**
- `inputSchema` is plain JSON Schema. Property `description` fields are read by the model, so write them as prompts rather than documentation
- Unregister via `registerTool(def, { signal: controller.signal })` then `controller.abort()`
- Origin isolation required, no `document.domain`. Gated by the `tools` Permissions Policy, default `self`
- Use the **declarative API** for the contact form. Using both APIs is a deliberate scoring decision

**Test in ChatGPT's in-app browser.** That is the judging surface. Chrome 149+ with `chrome://flags/#enable-webmcp-testing` is for local iteration only, and passing there proves nothing on its own. Install the Model Context Tool Inspector extension early.

## Design

Run the `web-signature` skill (`lilagents-team/web-signature`) before submission and fix everything `scripts/audit.mjs` fails on. Execution is an explicit judging criterion and a generic-looking page undercuts it. This is conversion mode, not experience mode: the site should look like a real plumber's site, because the agent layer is additive rather than the whole product.

## Repo hygiene, because this gets judged

- **MIT licence file, visible in the GitHub About section.** An explicit requirement that people fail
- README must contain: what it is, why WebMCP fits, how it was implemented, and how to run it locally
- No secrets committed, ever. The repo is public
- Commit messages: plain, no AI attribution, no em dashes

## Build and deploy traps

- **Never delete the whole `.netlify` directory.** It holds `state.json`, which is the link to the Netlify project. Deleting it silently unlinks the repo, and the next `netlify deploy` creates a **brand new site** and deploys there instead. This has already happened once. To clear a build collision delete `dist` and `.netlify/v1` only, never the parent.
- **Relink with the project ID, not the name:** `netlify link --id 1f760a1f-130b-43c6-87ec-b29b0bdc78cd`. If it says "already linked" to the wrong project, run `netlify unlink` first, because link is a no-op when a link already exists.
- **New functions need `--skip-functions-cache`.** Netlify reuses a cached function bundle, so a newly added function silently never registers its path and every call falls through to the catch-all 404.
- **Parallel agents must not run `pnpm run build` at the same time.** Concurrent builds collide on `dist` and `.netlify/v1` with EEXIST or ENOENT on the SSR entry. Give one agent the build, or stagger them.

## Working style

Verify before claiming. If a tool works, show the call and its output. If the site is live, load it. Never describe something as done because the code looks right, because the failure modes here are all runtime and browser-specific.

When something in BUSINESS.md turns out to be wrong, fix it there rather than working around it silently.
