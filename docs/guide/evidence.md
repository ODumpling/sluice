# Evidence & replay

```sh
sluice record scripts/subscribe-and-renew.yaml -o base.json
sluice replay base.json -n 10                 # determinism: expect "no behavior differences" ×10
sluice replay base.json --ref my-branch -o pr.json
sluice diff base.json pr.json [--json] [--ignore 'db.*.new.updated_at']
```

A **script** is a list of steps: `http` (with `save` captures and `${var}`
interpolation in `path`, `body` and `headers`), `browser` (drive the app's
frontend in the sandbox browser — see [Browser](/guide/browser)),
`advance: 35d`, `clock: <ISO>`.
Authenticate by saving a token from a login response:

```yaml
steps:
  - http: { method: POST, path: /api/login, body: { user: ada, password: pw } }
    save: { token: body.token }
  - http: { method: GET, path: /api/me, headers: { authorization: 'Bearer ${token}' } }
    expect: { status: 200 }
```

A **session** records per step: the ingress exchange, every call the app made
to fakes (egress), row-level DB writes (audit triggers attached automatically
by an event trigger, so the app's own migrations are covered) and domain
events — plus the final fake and DB state. `sluice timeline <session>` (or
`sluice record --html <file>`) renders it as a page: per step, the action, the
requests, and the data changes that followed.

The **diff** canonicalizes generated ids by first appearance, drops noise
paths and aligns record lists with LCS, so one extra DB write shows up as one
addition:

```
step 3: POST /subscriptions/${sub}/cancel
  ~ response.status: 404 -> 200
  + egress[0]: {"fake":"stripe","method":"DELETE","path":"/v1/subscriptions/sub_#1",…}
  + db[0]: {"table":"subscriptions","op":"UPDATE","new":{"status":"canceled",…}}
```
