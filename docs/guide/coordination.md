# Coordination

## Work queue

```sh
sluice work add "Add currency to invoices" --id T-A
sluice work add "Invoice UI" --id T-UI --dep T-A
sluice work claim --agent agent-a          # atomic
sluice work start T-A --agent agent-a
sluice work submit T-A --agent agent-a
sluice work approve T-A --as lead          # promotes T-UI to ready
```

States: `pending → ready → claimed → in_progress → review → done`, plus
`blocked` (waiting on a decision), `failed`, `canceled`. SQLite by default;
set `work.url: postgres://…` for Postgres.

## Symbol leases

```sh
sluice lease symbols [--refs src/types.ts#Invoice]
sluice lease sync  --agent agent-a --task T-A --base main --head agent-a
sluice lease check --agent agent-b --task T-B --base main --head agent-b   # pre-merge; exit 1 on conflict
sluice lease release --agent agent-a --task T-A
```

`lease sync` maps the branch diff to top-level symbols with the TypeScript
language service and leases them all-or-nothing. Another task touching a
leased symbol gets `CONFLICT src/types.ts#Invoice is leased by agent-a for T-A`
before merge. If a change alters an exported symbol's signature, agents
holding leases on dependent symbols receive an `interface_changed`
notification.

## Inbox

```sh
sluice inbox ask --agent agent-b --task T-B --kind choice \
  --question "Name the amount field total or amountCents?" --option total --option amountCents
sluice inbox list
sluice inbox answer dec_… amountCents --as lead@acme.test
```

The task blocks until answered. The same question from other agents (or an
explicit `--key`) is merged into one decision; the typed answer is propagated
to every affected task (`task.data.decisions`).
