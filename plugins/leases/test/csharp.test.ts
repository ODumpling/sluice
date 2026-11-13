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
const INVOICE = 'App/Models/Invoice.cs#Invoice'; // partial: id uses the part in the file named after the type

describe('C# symbol index (tree-sitter, namespace-aware)', () => {
  let dir: string;
  let idx: SymbolIndex;
  beforeAll(() => {
    dir = writeTree(FIXTURE);
    idx = SymbolIndex.build(dir);
  });

  it('indexes type declarations (block + file-scoped namespaces, nested, records); skips bin/', () => {
    expect(idx.symbols().map((s) => s.id)).toEqual([
      'App/Models/Invoice.cs#IEntity',
      INVOICE,
      'App/Models/Invoice.cs#Invoice.Hidden',
      'App/Models/Invoice.cs#Invoice.Line',
      'App/Services/Billing.cs#Billing',
      'App/Services/Reports.cs#Other',
      'App/Services/Reports.cs#Reports',
      'App/Shared/Money.cs#AuditedAttribute',
      'App/Shared/Money.cs#Helpers',
      'App/Shared/Money.cs#Money',
      'App/Shared/Money.cs#MoneyExtensions',
      'App/Util/Unrelated.cs#Invoice',
      'App/Util/Unrelated.cs#UsesLocal',
    ]);
    expect(idx.get('App/Shared/Money.cs#Money')).toMatchObject({ kind: 'record', exported: true, language: 'csharp' });
    expect(idx.get('App/Models/Invoice.cs#IEntity')!.kind).toBe('interface');
    expect(idx.get('App/Services/Reports.cs#Other')!.exported).toBe(true); // internal: visible assembly-wide
    expect(idx.get('App/Models/Invoice.cs#Invoice.Hidden')!.exported).toBe(false);
    expect(idx.get('App/Models/Invoice.cs#Invoice.Line')).toMatchObject({ exported: true, container: INVOICE });
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
    expect(at('App/Models/Invoice.cs', 'Qty')).toEqual(['App/Models/Invoice.cs#Invoice.Line']);
  });

  it('resolves references through namespaces, usings, aliases, global usings and qualified names', () => {
    expect(deps(idx, INVOICE)).toEqual(['App/Services/Billing.cs#Billing', 'App/Services/Reports.cs#Reports']);
    expect(deps(idx, 'App/Util/Unrelated.cs#Invoice')).toEqual(['App/Util/Unrelated.cs#UsesLocal']);
    expect(deps(idx, 'App/Models/Invoice.cs#Invoice.Line')).toEqual(['App/Services/Billing.cs#Billing']);
    expect(deps(idx, 'App/Models/Invoice.cs#IEntity')).toEqual([INVOICE]);
    expect(deps(idx, 'App/Shared/Money.cs#Money')).toEqual([
      'App/Services/Billing.cs#Billing',
      'App/Shared/Money.cs#MoneyExtensions',
    ]);
  });

  it('resolves attributes, using static members and extension methods', () => {
    expect(deps(idx, 'App/Shared/Money.cs#AuditedAttribute')).toEqual(['App/Services/Billing.cs#Billing']);
    const helpers = idx.references('App/Shared/Money.cs#Helpers').map((r) => r.line);
    expect(helpers).toContain(lineOf(dir, 'App/Services/Billing.cs', 'Clamp(3)'));
    expect(deps(idx, 'App/Shared/Money.cs#MoneyExtensions')).toEqual(['App/Services/Billing.cs#Billing']);
  });

  it('does not count names shadowed by a parameter or local', () => {
    const lines = idx.references('App/Shared/Money.cs#Money').map((r) => `${r.file}:${r.line}`);
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
    ).toEqual([`changed ${INVOICE}`, 'changed App/Models/Invoice.cs#Invoice.Line']);
    expect(changed({ 'App/Shared/Money.cs': (s) => s.replace('Money(decimal Amount', 'Money(long Amount') })).toEqual([
      'changed App/Shared/Money.cs#Money',
    ]);
  });
});

describe('C# lease flow (coord-demo-dotnet)', () => {
  const INV = 'src/CoordDemo/Types/Invoice.cs#Invoice';
  const REPORT = 'src/CoordDemo/Reporting/Report.cs#Report';
  let repo: DemoRepo;
  beforeAll(() => {
    repo = new DemoRepo(EXAMPLE);
  });

  it('indexes the demo', () => {
    const idx = SymbolIndex.build(repo.dir);
    expect(idx.dependents(INV).map((s) => s.id)).toEqual([
      'src/CoordDemo/Billing/InvoiceFactory.cs#InvoiceFactory',
      REPORT,
    ]);
    expect(idx.dependents('src/CoordDemo/Util/Slug.cs#Slug')).toEqual([]);
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
