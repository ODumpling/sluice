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

`lease sync` maps the branch diff to symbols and leases them all-or-nothing.
Another task touching a leased symbol gets `CONFLICT src/types.ts#Invoice is
leased by agent-a for T-A` before merge. If a change alters an exported
symbol's signature, agents holding leases on dependent symbols receive an
`interface_changed` notification.

### Languages

One index covers every language in the repository (a mixed TS + Go + C# repo
indexes all three). Go and C# need no toolchain on the host: they are parsed
with tree-sitter.

|           | TypeScript / JavaScript                                    | Go                                                                                                              | C#                                                                                                                                |
| --------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| engine    | TypeScript language service                                | tree-sitter                                                                                                     | tree-sitter                                                                                                                       |
| symbols   | top-level declarations                                     | funcs, methods, types (struct / interface / defined / alias), consts, vars                                      | types: class, struct, interface, record (class / struct), enum, delegate                                                          |
| ids       | `src/types.ts#Invoice`                                     | `store/store.go#Memory`, methods `store/store.go#Memory.Get`                                                    | `src/Models/Invoice.cs#Acme.Models.Invoice`, generic ``…#Acme.Box`1``, nested `…#Acme.Models.Invoice.Line`                        |
| exported  | `export`                                                   | exported identifier (upper case)                                                                                | visible outside its file: top-level types unless `file`-local (internal counts: it is assembly-wide); nested types unless private |
| signature | type text / function signature / non-private class members | param / result types, exported struct fields + tags, interface method set, alias / defined target, const values | modifiers, type params, base list, constraints, non-private members without bodies / initializers                                 |
| skipped   | `node_modules`, `dist`, `*.d.ts`                           | `vendor/`, `testdata/`                                                                                          | `bin/`, `obj/`                                                                                                                    |

Body-only, comment-only and private changes are not interface changes.

**Go references** are package-aware. Package = directory (+ package clause, so
`foo_test` is separate). Unqualified names resolve to the package's top-level
declarations in any file of the package, unless shadowed by a local (params,
results, receivers, type params, `:=`, block `var` / `const` / `type`, range,
type-switch and select variables). `alias.Name` resolves through the file's
imports, mapped to directories with the nearest `go.mod` module path (root,
nested modules and go.work members alike); dot imports are followed. Method
selectors `x.M` resolve when x's type is syntactically known (param / var
type, composite literal, `&T{}`, `new(T)`, conversion, result of an indexed
func / method, promotion through embedded fields); otherwise a call `x.M()`
matches the one indexed method named `M` if it is unique (and only in the
method's package or its importers). Calls through interface values are not
attributed to implementations. Embedded fields and interface embedding count
as references. A method's receiver type counts as a reference, so a type's
methods depend on it.

**C# references** follow C# name lookup: enclosing types (nested types), the
namespace and its parents, `using` / `using static` / alias directives at each
level, `global using` anywhere in the project (nearest `*.csproj`), and
fully-qualified or `global::` names. Counted positions: type syntax (fields,
params, returns, generics, arrays, nullable, casts, patterns, `typeof`,
`nameof`), `new X()`, static access `X.Y`, base lists, constraints, attributes
(`[Audited]` → `AuditedAttribute`), members imported with `using static`, and
extension-method calls when the extension class's namespace is in scope. A
name shadowed by a parameter or local (in expression position) or a type
parameter is not counted. Members reached only through an inferred type
(`var x = repo.Get(); x.Total`) are not attributed to the type.

**Symbol identity.** C# ids are `path#` + the .NET metadata-style name:
namespace, enclosing types and generic arity (`Acme.Models.Invoice`,
``Acme.Box`1``, ``Acme.Outer`1.Inner``; a type in the global namespace is just
`path#Name`). So `namespace A { class Item }` and `namespace B { class Item }`
in one file, or `Box` and `Box<T>`, are distinct symbols with separate
leases, conflicts and broadcasts; the same names key partial-type merging and
reference lookup (`Box<int>` resolves to ``Box`1``, `typeof(Box<,>)` to
``Box`2``). Go ids are unique per package scope (`path#Name`, methods
`path#Recv.Method`, generic receivers drop their type parameters:
`path#Box.Get`); several `init()` in one file are one symbol with several
parts, and same-named declarations in build-constrained files
(`open_linux.go` / `open_darwin.go`) are separate symbols that each receive the
references to that name.

**Partial classes** are one symbol (per project and metadata name).
The id uses the part in the file named after the type (`Invoice.cs`), else
the first part by path; every part is listed in `parts`, so an edit to any
part maps to the symbol, and a public member added in any part is an
interface change. Nested types are their own symbols; an edit inside a nested
type leases the nested type, not its container.

Examples: `examples/coord-demo` (TypeScript), `examples/coord-demo-go`,
`examples/coord-demo-dotnet`.

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
