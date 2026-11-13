// C#: tree-sitter symbol index (namespace-aware references), interface changes and the lease flow.
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SymbolIndex, interfaceChanges } from '@sluice-dev/plugin-leases';
import { DemoRepo, lineOf, variant, writeTree } from './helpers.js';

const EXAMPLE = join(import.meta.dirname, '..', '..', '..', 'examples', 'coord-demo-dotnet');

const FIXTURE: Record<string, string> = {
  'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
  'App/GlobalUsings.cs': 'global using Acme.Shared;\n',
  'App/Models/Invoice.cs': `namespace Acme.Models
{
    /// <summary>An invoice.</summary>
    public partial class Invoice : IEntity
    {
        public string Id { get; set; } = "";
        private int _secret;

        public decimal Total()
        {
            return 1;
        }

        public class Line
        {
            public int Qty { get; set; }
        }

        private class Hidden { }
    }

    public interface IEntity
    {
        string Id { get; }
    }
}
`,
  'App/Models/Invoice.Extra.cs': `namespace Acme.Models;

public partial class Invoice
{
    public string Currency { get; set; } = "USD";
}
`,
  'App/Shared/Money.cs': `namespace Acme.Shared;

public readonly record struct Money(decimal Amount, string Currency)
{
    public static Money Zero => new(0, "USD");
}

public static class MoneyExtensions
{
    public static Money Twice(this Money m) => m with { Amount = m.Amount + m.Amount };
}

[AttributeUsage(AttributeTargets.Class)]
public sealed class AuditedAttribute : Attribute { }

public static class Helpers
{
    public static int Clamp(int x) => x;
}
`,
  'App/Services/Billing.cs': `using Acme.Models;
using static Acme.Shared.Helpers;
using Inv = Acme.Models.Invoice;

namespace Acme.Services;

[Audited]
public class Billing
{
    public Money Sum(Inv a, Invoice.Line l)
    {
        return Money.Zero.Twice();
    }

    public int Clamped() => Clamp(3);

    public object Shadowed(int Money)
    {
        return Money; // shadowed
    }
}
`,
  'App/Services/Reports.cs': `namespace Acme.Services
{
    public class Reports
    {
        public global::Acme.Models.Invoice? Latest() => null;
    }

    internal class Other
    {
        public int Ignored() => 1;
    }
}
`,
  'App/Util/Unrelated.cs': `namespace Other.Place
{
    public class Invoice { }

    public class UsesLocal
    {
        private Invoice _i = new();
    }
}
`,
  'App/bin/Debug/Generated.cs': 'namespace Gen { public class Generated { } }\n',
};

const deps = (idx: SymbolIndex, id: string) => idx.dependents(id).map((s) => s.id);
const INVOICE = 'App/Models/Invoice.cs#Acme.Models.Invoice'; // partial: id uses the part in the file named after the type

describe('C# symbol index (tree-sitter, namespace-aware)', () => {
  let dir: string;
  let idx: SymbolIndex;
  beforeAll(() => {
    dir = writeTree(FIXTURE);
    idx = SymbolIndex.build(dir);
  });

  it('indexes type declarations (block + file-scoped namespaces, nested, records); skips bin/', () => {
    expect(idx.symbols().map((s) => s.id)).toEqual([
      'App/Models/Invoice.cs#Acme.Models.IEntity',
      INVOICE,
      'App/Models/Invoice.cs#Acme.Models.Invoice.Hidden',
      'App/Models/Invoice.cs#Acme.Models.Invoice.Line',
      'App/Services/Billing.cs#Acme.Services.Billing',
      'App/Services/Reports.cs#Acme.Services.Other',
      'App/Services/Reports.cs#Acme.Services.Reports',
      'App/Shared/Money.cs#Acme.Shared.AuditedAttribute',
      'App/Shared/Money.cs#Acme.Shared.Helpers',
      'App/Shared/Money.cs#Acme.Shared.Money',
      'App/Shared/Money.cs#Acme.Shared.MoneyExtensions',
      'App/Util/Unrelated.cs#Other.Place.Invoice',
      'App/Util/Unrelated.cs#Other.Place.UsesLocal',
    ]);
    expect(idx.get('App/Shared/Money.cs#Acme.Shared.Money')).toMatchObject({
      kind: 'record',
      exported: true,
      language: 'csharp',
    });
    expect(idx.get('App/Models/Invoice.cs#Acme.Models.IEntity')!.kind).toBe('interface');
    expect(idx.get('App/Services/Reports.cs#Acme.Services.Other')!.exported).toBe(true); // internal: visible assembly-wide
    expect(idx.get('App/Models/Invoice.cs#Acme.Models.Invoice.Hidden')!.exported).toBe(false);
    expect(idx.get('App/Models/Invoice.cs#Acme.Models.Invoice.Line')).toMatchObject({
      exported: true,
      container: INVOICE,
    });
  });

  it('a partial class is one symbol; symbolsAt works for every part and prefers nested types', () => {
    const inv = idx.get(INVOICE)!;
    expect(inv.parts?.map((p) => p.file)).toEqual(['App/Models/Invoice.cs', 'App/Models/Invoice.Extra.cs']);
    const at = (file: string, needle: string) => {
      const l = lineOf(dir, file, needle);
      return idx.symbolsAt(file, [[l, l]]).map((s) => s.id);
    };
    expect(at('App/Models/Invoice.cs', 'return 1;')).toEqual([INVOICE]);
    expect(at('App/Models/Invoice.Extra.cs', 'Currency')).toEqual([INVOICE]);
    expect(at('App/Models/Invoice.cs', 'Qty')).toEqual(['App/Models/Invoice.cs#Acme.Models.Invoice.Line']);
  });

  it('resolves references through namespaces, usings, aliases, global usings and qualified names', () => {
    expect(deps(idx, INVOICE)).toEqual([
      'App/Services/Billing.cs#Acme.Services.Billing',
      'App/Services/Reports.cs#Acme.Services.Reports',
    ]);
    expect(deps(idx, 'App/Util/Unrelated.cs#Other.Place.Invoice')).toEqual([
      'App/Util/Unrelated.cs#Other.Place.UsesLocal',
    ]);
    expect(deps(idx, 'App/Models/Invoice.cs#Acme.Models.Invoice.Line')).toEqual([
      'App/Services/Billing.cs#Acme.Services.Billing',
    ]);
    expect(deps(idx, 'App/Models/Invoice.cs#Acme.Models.IEntity')).toEqual([INVOICE]);
    expect(deps(idx, 'App/Shared/Money.cs#Acme.Shared.Money')).toEqual([
      'App/Services/Billing.cs#Acme.Services.Billing',
      'App/Shared/Money.cs#Acme.Shared.MoneyExtensions',
    ]);
  });

  it('resolves attributes, using static members and extension methods', () => {
    expect(deps(idx, 'App/Shared/Money.cs#Acme.Shared.AuditedAttribute')).toEqual([
      'App/Services/Billing.cs#Acme.Services.Billing',
    ]);
    const helpers = idx.references('App/Shared/Money.cs#Acme.Shared.Helpers').map((r) => r.line);
    expect(helpers).toContain(lineOf(dir, 'App/Services/Billing.cs', 'Clamp(3)'));
    expect(deps(idx, 'App/Shared/Money.cs#Acme.Shared.MoneyExtensions')).toEqual([
      'App/Services/Billing.cs#Acme.Services.Billing',
    ]);
  });

  it('does not count names shadowed by a parameter or local', () => {
    const lines = idx.references('App/Shared/Money.cs#Acme.Shared.Money').map((r) => `${r.file}:${r.line}`);
    expect(lines).toContain(`App/Services/Billing.cs:${lineOf(dir, 'App/Services/Billing.cs', 'return Money.Zero')}`);
    expect(lines).not.toContain(`App/Services/Billing.cs:${lineOf(dir, 'App/Services/Billing.cs', '// shadowed')}`);
    expect(lines).not.toContain(`App/Services/Billing.cs:${lineOf(dir, 'App/Services/Billing.cs', 'int Money')}`);
  });

  it('detects interface changes on public shapes only (any partial part)', () => {
    const changed = (edits: Record<string, (s: string) => string>) =>
      interfaceChanges(idx, SymbolIndex.build(variant(dir, edits))).map((c) => `${c.kind} ${c.id}`);
    expect(
      changed({
        'App/Models/Invoice.cs': (s) =>
          s
            .replace('return 1;', 'return 2;')
            .replace('private int _secret;', 'private long _secret;')
            .replace('/// <summary>An invoice.</summary>', '/// <summary>A bill.</summary>')
            .replace('private class Hidden { }', 'private class Hidden { public int X; }')
            .replace('= "";', '= "none";'),
      }),
    ).toEqual([]);
    expect(
      changed({
        'App/Models/Invoice.Extra.cs': (s) => s.replace('}\n', '    public decimal Tax { get; set; }\n}\n'),
        'App/Models/Invoice.cs': (s) => s.replace('public int Qty', 'public long Qty'),
      }),
    ).toEqual([`changed ${INVOICE}`, 'changed App/Models/Invoice.cs#Acme.Models.Invoice.Line']);
    expect(changed({ 'App/Shared/Money.cs': (s) => s.replace('Money(decimal Amount', 'Money(long Amount') })).toEqual([
      'changed App/Shared/Money.cs#Acme.Shared.Money',
    ]);
  });
});

describe('C# lease flow (coord-demo-dotnet)', () => {
  const INV = 'src/CoordDemo/Types/Invoice.cs#CoordDemo.Types.Invoice';
  const REPORT = 'src/CoordDemo/Reporting/Report.cs#CoordDemo.Reporting.Report';
  let repo: DemoRepo;
  beforeAll(() => {
    repo = new DemoRepo(EXAMPLE);
  });

  it('indexes the demo', () => {
    const idx = SymbolIndex.build(repo.dir);
    expect(idx.dependents(INV).map((s) => s.id)).toEqual([
      'src/CoordDemo/Billing/InvoiceFactory.cs#CoordDemo.Billing.InvoiceFactory',
      REPORT,
    ]);
    expect(idx.dependents('src/CoordDemo/Util/Slug.cs#CoordDemo.Util.Slug')).toEqual([]);
  });

  it('leases, broadcasts interface changes to dependents and blocks conflicting edits before merge', async () => {
    repo.agentEdit(
      'agent-c',
      { 'src/CoordDemo/Reporting/Report.cs': (s) => s.replace(':F2}', ':C}') },
      'report: currency format',
    );
    const c = await repo.cli('lease', 'sync', '--agent', 'agent-c', '--task', 'T-C', '--head', 'agent-c');
    expect(c.code).toBe(0);
    expect(c.out).toContain(`leased ${REPORT}`);

    repo.agentEdit(
      'agent-a',
      {
        'src/CoordDemo/Types/Invoice.cs': (s) =>
          s.replace(
            'public long AmountCents { get; init; }\n',
            'public long AmountCents { get; init; }\n    public string Currency { get; init; } = "USD";\n',
          ),
      },
      'types: add currency',
    );
    const a = await repo.cli('lease', 'sync', '--agent', 'agent-a', '--task', 'T-A', '--head', 'agent-a');
    expect(a.code).toBe(0);
    expect(a.out).toContain(`leased ${INV}`);
    expect(a.out).toContain(`interface changed: ${INV}`);
    expect(a.out).toContain('notified agent-c');
    const inbox = JSON.parse((await repo.cli('inbox', 'list', '--agent', 'agent-c', '--json')).out) as {
      notifications: { kind: string; data: { symbol: string; dependent: string; after: string } }[];
    };
    expect(inbox.notifications).toEqual([
      expect.objectContaining({
        kind: 'interface_changed',
        data: expect.objectContaining({
          symbol: INV,
          dependent: REPORT,
          after: expect.stringContaining('public string Currency{get;init;}'),
        }),
      }),
    ]);

    repo.agentEdit(
      'agent-b',
      {
        'src/CoordDemo/Types/Invoice.cs': (s) => s.replaceAll('AmountCents', 'Total'),
        'src/CoordDemo/Billing/InvoiceFactory.cs': (s) => s.replaceAll('AmountCents', 'Total'),
      },
      'rename AmountCents -> Total',
    );
    const b = await repo.cli('lease', 'sync', '--agent', 'agent-b', '--task', 'T-B', '--head', 'agent-b');
    expect(b.code).toBe(1);
    expect(b.out).toContain(`CONFLICT ${INV} is leased by agent-a for T-A`);
    const check = await repo.cli('lease', 'check', '--agent', 'agent-b', '--task', 'T-B', '--head', 'agent-b');
    expect(check.code).toBe(1);
    expect(check.out).toContain(`CONFLICT ${INV}`);
    expect((await repo.cli('lease', 'list')).out).not.toContain('agent-b');
    expect((await repo.cli('lease', 'check', '--agent', 'agent-a', '--task', 'T-A', '--head', 'agent-a')).code).toBe(0);
  });
});

describe('C# symbol identity (namespace + enclosing types + generic arity)', () => {
  const FILES: Record<string, string> = {
    'sluice.yaml': 'version: 1\nname: ids\n',
    'Ids/Ids.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
    'Ids/Types.cs': `namespace A
{
    public class Item
    {
        public int X { get; set; }
    }
}

namespace B
{
    public class Item
    {
        public int Y { get; set; }
    }
}

namespace C
{
    using A;

    public class UsesA
    {
        public Item? I;
    }
}

namespace D
{
    public class UsesB
    {
        public B.Item? I;
    }
}

public class Box
{
    public int V;
}

public partial class Box<T>
{
    public T? V;
}

public class UsesBox
{
    public Box? P;
}

public class UsesGenericBox
{
    public Box<int>? Q;
    public System.Type T = typeof(Box<>);
}
`,
    'Ids/Z.cs': 'public partial class Box<T>\n{\n    public T? W;\n}\n',
  };
  const AITEM = 'Ids/Types.cs#A.Item';
  const BITEM = 'Ids/Types.cs#B.Item';
  const BOX = 'Ids/Types.cs#Box';
  const BOX1 = 'Ids/Types.cs#Box`1';

  it('same-named types in different namespaces of one file, and Box vs Box<T>, are distinct symbols', () => {
    const dir = writeTree(FILES);
    const idx = SymbolIndex.build(dir);
    expect(idx.symbols().map((s) => s.id)).toEqual([
      AITEM,
      BITEM,
      BOX,
      BOX1,
      'Ids/Types.cs#C.UsesA',
      'Ids/Types.cs#D.UsesB',
      'Ids/Types.cs#UsesBox',
      'Ids/Types.cs#UsesGenericBox',
    ]);
    expect(idx.get(BOX1)!.parts?.map((p) => p.file)).toEqual(['Ids/Types.cs', 'Ids/Z.cs']); // partial Box<T> only
    expect(idx.get(BOX)!.parts).toBeUndefined();
    const at = (needle: string) => {
      const l = lineOf(dir, 'Ids/Types.cs', needle);
      return idx.symbolsAt('Ids/Types.cs', [[l, l]]).map((s) => s.id);
    };
    expect(at('int X')).toEqual([AITEM]);
    expect(at('int Y')).toEqual([BITEM]);
    expect(at('public int V;')).toEqual([BOX]);
    expect(at('public T? V;')).toEqual([BOX1]);
    const deps = (id: string) => idx.dependents(id).map((s) => s.id);
    expect(deps(AITEM)).toEqual(['Ids/Types.cs#C.UsesA']);
    expect(deps(BITEM)).toEqual(['Ids/Types.cs#D.UsesB']);
    expect(deps(BOX)).toEqual(['Ids/Types.cs#UsesBox']);
    expect(deps(BOX1)).toEqual(['Ids/Types.cs#UsesGenericBox']);
    const changes = interfaceChanges(
      idx,
      SymbolIndex.build(variant(dir, { 'Ids/Types.cs': (s) => s.replace('int X', 'long X') })),
    );
    expect(changes.map((c) => c.id)).toEqual([AITEM]);
    const generic = interfaceChanges(
      idx,
      SymbolIndex.build(variant(dir, { 'Ids/Z.cs': (s) => s.replace('T? W', 'T? W2') })),
    );
    expect(generic.map((c) => c.id)).toEqual([BOX1]);
  });

  it('leases, conflicts and broadcasts per type, not per file name', async () => {
    const repo = new DemoRepo(writeTree(FILES));
    repo.agentEdit('agent-c', { 'Ids/Types.cs': (s) => s.replace('public Item? I;', 'public Item? I = null;') }, 'c');
    const c = await repo.cli('lease', 'sync', '--agent', 'agent-c', '--task', 'T-C', '--head', 'agent-c');
    expect(c.code).toBe(0);
    expect(c.out).toContain('leased Ids/Types.cs#C.UsesA\n');

    repo.agentEdit('agent-a', { 'Ids/Types.cs': (s) => s.replace('int X', 'long X') }, 'a');
    const a = await repo.cli('lease', 'sync', '--agent', 'agent-a', '--task', 'T-A', '--head', 'agent-a');
    expect(a.code).toBe(0);
    expect(a.out).toContain(`leased ${AITEM}\n`);
    expect(a.out).toContain(`interface changed: ${AITEM}`);
    expect(a.out).toContain('notified agent-c');

    // same file, same simple name, other namespace: no conflict, and agent-c (UsesA) is not notified
    repo.agentEdit('agent-b', { 'Ids/Types.cs': (s) => s.replace('int Y', 'long Y') }, 'b');
    const b = await repo.cli('lease', 'sync', '--agent', 'agent-b', '--task', 'T-B', '--head', 'agent-b');
    expect(b.code).toBe(0);
    expect(b.out).toContain(`leased ${BITEM}\n`);
    expect(b.out).not.toContain('notified');

    // a second edit of A.Item conflicts
    repo.agentEdit('agent-d', { 'Ids/Types.cs': (s) => s.replace('int X', 'short X') }, 'd');
    const d = await repo.cli('lease', 'check', '--agent', 'agent-d', '--task', 'T-D', '--head', 'agent-d');
    expect(d.code).toBe(1);
    expect(d.out).toContain(`CONFLICT ${AITEM} is leased by agent-a for T-A`);
    expect(d.out).not.toContain(BITEM);
  });
});
