# coord-demo-go

The Go version of [coord-demo](../coord-demo): `types/invoice.go#Invoice` (a struct with a `Dollars` method, `types/invoice.go#Invoice.Dollars`) used by the `billing` and `report` packages, for the coordination features: symbol leases, pre-merge `lease check` and interface-change broadcast.

Symbols are indexed with tree-sitter (no Go toolchain needed); imports resolve through `go.mod` (`example.com/coorddemo`).

```sh
sluice lease symbols --refs types/invoice.go#Invoice
```

See `plugins/leases/test/go.test.ts` for a scripted run with three simulated agents, and [docs/guide/coordination.md](../../docs/guide/coordination.md).
