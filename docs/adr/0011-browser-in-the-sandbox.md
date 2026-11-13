# ADR-0011: Browser steps run Playwright inside the sandbox

- Status: accepted
- Date: 2026-11-13

## Context

Evidence covered the HTTP API, egress, DB writes and events, but many changes
are reached through a frontend. Developers want to see a click end to end:
what the page requested, and which data changed as a result.

## Decision

- **Where the browser runs**: in a container on the sandbox's `--internal`
  network (`sluice-browser:<playwright version>`, built from the official
  `mcr.microsoft.com/playwright` image plus a small `launchServer` script that
  fixes Chromium flags). The host connects with `playwright-core` through a
  gateway-published port. No host browser install, and the browser has no
  route out, like the app. Started lazily on the first `browser` step, kept
  across `reset()` (each run opens a fresh context), removed by `down()`.
- **Versions**: the client (`playwright-core` in `@sluice-dev/evidence`) and
  the image are pinned to the same exact version (`PLAYWRIGHT_VERSION`,
  checked by a unit test); Playwright's protocol requires it.
- **Addressing**: every service gets a `<name>.sluice.internal` network alias
  and the browser uses it for the ingress. Bare service names can be
  HSTS-preloaded TLDs (`app`, `dev`), which Chromium silently upgrades to
  https.
- **One action per step**, so the existing per-step capture attributes DB
  writes, egress and events to the action that caused them. After an action
  Sluice waits for network idle (300 ms quiet, 10 s cap) before snapshotting.
- **Recorded**: URL, title, visible text lines, document/fetch/XHR requests
  (bodies, JSON responses), console errors / page errors / failed requests,
  and a JPEG screenshot. Diffs add a `browser` channel; text, requests and
  console are LCS-aligned lists; screenshots are never diffed.
- **Determinism**: fixed `Date` that follows the sandbox clock, seeded
  `Math.random`, UTC, `en-US`, fixed viewport and scale.
- **Gate**: browser steps take `expect: { url, title, text, visible, hidden,
noErrors }`; an action that cannot be performed fails the scenario. Reports
  embed the head run's timeline; mutant and base runs skip screenshots.

## Consequences

- First use pulls a large image (~1 GB compressed); API-only users pay
  nothing.
- Frontends that load third-party scripts (CDNs, Stripe.js) see those
  requests fail; they show up as failed requests in the evidence.
- Only Chromium. Pixel diffs are out of scope; the visible text and requests
  carry the behavior.
