# coord-demo

A small TypeScript service (`src/types.ts#Invoice` used by `billing.ts` and `report.ts`) for the coordination features: work queue, symbol leases, interface-change broadcast and the decision inbox.

See `plugins/leases/test/coordination.test.ts` for a scripted run with three simulated agents, and [docs/guide/coordination.md](../../docs/guide/coordination.md).
