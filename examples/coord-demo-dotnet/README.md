# coord-demo-dotnet

The C# version of [coord-demo](../coord-demo): `src/CoordDemo/Types/Invoice.cs#CoordDemo.Types.Invoice` used by `InvoiceFactory` and `Report` (in other namespaces, via `using`), for the coordination features: symbol leases, pre-merge `lease check` and interface-change broadcast.

Symbols (type declarations) are indexed with tree-sitter (no .NET SDK needed).

```sh
sluice lease symbols --refs src/CoordDemo/Types/Invoice.cs#CoordDemo.Types.Invoice
```

See `plugins/leases/test/csharp.test.ts` for a scripted run with three simulated agents, and [docs/guide/coordination.md](../../docs/guide/coordination.md).
