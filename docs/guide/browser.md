# Browser (frontend → data)

`browser` steps drive your app's frontend with Playwright and record, per
action, what the page did **and** what that did to your data: the requests
the page made, the DB writes, calls to third parties and domain events that
followed — all attributed to the click that caused them.

The browser runs **inside the sandbox**: a Playwright Chromium container on
the sandbox's internal network, reachable only through the gateway. Nothing to
install on the host; it has no route off the host, like the app.

## Enable it

```yaml
# sluice.yaml
sandbox:
  ingress: { service: app, port: 3000 }
  browser: true # or { viewport: { width: 1280, height: 800 }, actionTimeoutMs: 5000 }
```

The browser container starts on the first `browser` step, so enabling it costs
nothing for API-only scripts. The first use builds `sluice-browser:<playwright
version>` from the official `mcr.microsoft.com/playwright` image (a large
one-time pull). The page reaches the ingress at
`http://<service>.sluice.internal:<port>` (every service gets that alias; bare
names such as `app` or `dev` are HSTS-preloaded TLDs that browsers force to
https), so relative URLs in your frontend just work.

## Steps

```yaml
# scripts/portal-cancel.yaml
name: portal-cancel
steps:
  - http: { method: POST, path: /customers, body: { email: ada@example.com, name: Ada } }
    save: { cust: body.id }
  - http: { method: POST, path: /subscriptions, body: { customer_id: '${cust}', plan: pro_monthly } }
    save: { sub: body.id }
  - browser: { goto: '/portal/${sub}' }
  - browser: { click: 'role=button[name="Cancel subscription"]' }
  - advance: 35d
  - http: { method: POST, path: /jobs/sync-subscriptions }
  - browser: { goto: '/portal/${sub}' }
```

One action per step: `goto`, `click`, `fill` + `value`, `press` + `key`,
`select` + `value`, `check`, `uncheck`, `waitFor`. Selectors are
[Playwright selectors](https://playwright.dev/docs/other-locators) (CSS,
`text=…`, `role=button[name="…"]`) and must match one element. `${var}` works
in every field; `save: { name: <selector> }` saves an element's text.

After each action Sluice waits for the page's network to go idle, then
records: the URL, title and visible text, the page's document/fetch/XHR
requests (with bodies and JSON responses), console errors, uncaught errors and
failed requests, and a screenshot. A failing action (element never appeared)
is recorded as the step's `error` and the script continues.

The page sees the sandbox's frozen clock (`Date` follows `advance`/`clock`
steps), a seeded `Math.random`, UTC, `en-US` and a fixed viewport, so replays
are deterministic.

## See what happened

```sh
sluice record scripts/portal-cancel.yaml --html portal.html --trace trace.zip
sluice timeline .sluice/sessions/portal-cancel.json     # timeline page for any session
npx playwright show-trace trace.zip                     # DOM snapshots, network, console per action
```

The timeline shows, per step: screenshot, the page's requests, **data
changes** (DB writes; updates show only the changed columns) and **third
parties & events**:

```
4  browser click role=button[name="Cancel subscription"]
   Frontend       POST /subscriptions/1/cancel → 200
   Data changes   subscriptions #1 UPDATE cancel_at: null → 2030-02-15T12:00:00+00:00
   Third parties  stripe POST /v1/subscriptions/sub_… {"cancel_at_period_end":true}
                  event {"event":"subscription.cancel_scheduled",…}
```

Diffs get a `browser` channel (screenshots excluded), so a behavior change
reads from the screen down to the database:

```
step 4: browser click role=button[name="Cancel subscription"]
  ~ browser.network[0].response.status: "active" -> "canceled"
  ~ browser.text[2]: "Status: active" -> "Status: canceled"
  + egress[0]: {"fake":"stripe","method":"DELETE",…}
  ~ db[0].new.status: "active" -> "canceled"
```

Noise filters work as usual: `browser.text`, `browser.network.*.response.created`.

## In gate scenarios

```yaml
steps:
  - browser: { goto: '/portal/${sub}' }
    expect: { text: 'Renews on', visible: '#cancel' }
  - browser: { click: 'role=button[name="Cancel subscription"]' }
    expect: { text: [Status: active, Cancels on], hidden: '#cancel', noErrors: true }
```

`expect` on a browser step: `url` (exact), `title`, `text` (visible text
contains each), `visible` / `hidden` (selectors), `noErrors` (no console
errors, page errors or failed requests). An action that cannot be performed
fails the scenario. Gate reports include a per-scenario timeline of the head
run with screenshots. Mutant runs skip screenshots.
