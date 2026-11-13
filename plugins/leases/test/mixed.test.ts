// A polyglot repository (TS + Go + C#): one index, one change analysis.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SymbolIndex, analyzeChange } from '@sluice-dev/plugin-leases';
import { writeTree } from './helpers.js';

const FILES: Record<string, string> = {
  'web/src/types.ts': 'export interface Order {\n  id: string;\n}\n',
  'web/src/view.ts':
    "import type { Order } from './types.js';\n\nexport function show(o: Order): string {\n  return o.id;\n}\n",
  'svc/go.mod': 'module example.com/svc\n\ngo 1.23\n',
  'svc/order/order.go': 'package order\n\ntype Order struct {\n\tID string\n}\n',
  'svc/api/api.go':
    'package api\n\nimport "example.com/svc/order"\n\nfunc Show(o order.Order) string {\n\treturn o.ID\n}\n',
  'dotnet/Shop/Shop.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
  'dotnet/Shop/Order.cs': 'namespace Shop;\n\npublic class Order\n{\n    public string Id { get; set; } = "";\n}\n',
  'dotnet/Shop/View.cs':
    'namespace Shop.Views;\n\npublic static class View\n{\n    public static string Show(Order o) => o.Id;\n}\n',
};

describe('mixed-language repository', () => {
  let dir: string;
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  beforeAll(() => {
    dir = writeTree(FILES);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'dev@acme.test');
    git('config', 'user.name', 'dev');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A');
    git('commit', '-qm', 'init');
  });

  it('indexes every language with per-language references', () => {
    const idx = SymbolIndex.build(dir);
    expect(idx.symbols().map((s) => `${s.language} ${s.id}`)).toEqual([
      'csharp dotnet/Shop/Order.cs#Order',
      'csharp dotnet/Shop/View.cs#View',
      'go svc/api/api.go#Show',
      'go svc/order/order.go#Order',
      'typescript web/src/types.ts#Order',
      'typescript web/src/view.ts#show',
    ]);
    const deps = (id: string) => idx.dependents(id).map((s) => s.id);
    expect(deps('web/src/types.ts#Order')).toEqual(['web/src/view.ts#show']);
    expect(deps('svc/order/order.go#Order')).toEqual(['svc/api/api.go#Show']);
    expect(deps('dotnet/Shop/Order.cs#Order')).toEqual(['dotnet/Shop/View.cs#View']);
    expect(SymbolIndex.build(dir, { languages: ['go'] }).symbols().length).toBe(2);
  });

  it('maps one branch diff to touched symbols and interface changes in all languages', async () => {
    git('checkout', '-q', '-b', 'feature');
    const edit = (f: string, fn: (s: string) => string) =>
      writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), 'utf8')));
    edit('web/src/types.ts', (s) => s.replace('  id: string;\n', '  id: string;\n  total: number;\n'));
    edit('svc/order/order.go', (s) => s.replace('\tID string\n', '\tID    string\n\tTotal int64\n'));
    edit('dotnet/Shop/Order.cs', (s) => s.replace('= "";\n', '= "";\n    public long Total { get; set; }\n'));
    git('commit', '-qam', 'add totals');
    git('checkout', '-q', 'main');
    const a = await analyzeChange(dir, 'main', 'feature');
    expect(a.touched.map((s) => s.id)).toEqual([
      'dotnet/Shop/Order.cs#Order',
      'svc/order/order.go#Order',
      'web/src/types.ts#Order',
    ]);
    expect(a.interfaceChanges.map((c) => `${c.kind} ${c.id}`)).toEqual([
      'changed dotnet/Shop/Order.cs#Order',
      'changed svc/order/order.go#Order',
      'changed web/src/types.ts#Order',
    ]);
    expect(a.dependents).toEqual({
      'dotnet/Shop/Order.cs#Order': ['dotnet/Shop/View.cs#View'],
      'svc/order/order.go#Order': ['svc/api/api.go#Show'],
      'web/src/types.ts#Order': ['web/src/view.ts#show'],
    });
  });
});
