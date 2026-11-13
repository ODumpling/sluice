// Go: tree-sitter symbol index (package-aware references), interface changes and the lease flow.
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SymbolIndex, interfaceChanges } from '@sluice-dev/plugin-leases';
import { DemoRepo, lineOf, variant, writeTree } from './helpers.js';

const EXAMPLE = join(import.meta.dirname, '..', '..', '..', 'examples', 'coord-demo-go');

const FIXTURE: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.23\n',
  'store/store.go': `package store

// Item is stored.
type Item struct {
	Name   string \`json:"name"\`
	secret int
}

type Store interface {
	Get(id string) (*Item, error)
}

type ReadStore interface {
	Store
}

type Base struct{}

func (b *Base) Close() error { return nil }

type Memory struct {
	Base
	items map[string]*Item
}

func (m *Memory) Get(id string) (*Item, error) {
	return m.items[id], nil
}

func NewMemory() *Memory {
	return &Memory{items: map[string]*Item{}}
}

func helper() int { return 1 }

func Count(s Store) int {
	return helper()
}

const Limit = 10

var Default = NewMemory()
`,
  'store/extra.go': `package store

func Uses() int {
	return helper() + Limit
}

func Shadow(helper int) int {
	return helper
}

func Shadow2() int {
	helper := 2
	return helper
}

func Shadow3() int {
	{
		var Limit = 3
		_ = Limit // inner
	}
	return Limit // outer
}
`,
  'api/handler.go': `package api

import (
	"fmt"

	s "example.com/app/store"
)

type Handler struct {
	s.Store
	mem *s.Memory
}

func Handle(id string) string {
	mem := s.NewMemory()
	it, _ := mem.Get(id)
	_ = mem.Close()
	return fmt.Sprint(it.Name)
}

func Other(m *s.Memory) {
	m.Get("x")
}

func Fallback(xs []*s.Memory) {
	for _, x := range xs {
		x.Get("z")
	}
}

func Unknown(x interface{ Get(string) (*s.Item, error) }) {
	x.Get("y")
}
`,
  'tools/go.mod': 'module example.com/tools\n\ngo 1.23\n',
  'tools/lib/lib.go': 'package lib\n\nfunc Do() {}\n',
  'tools/gen/gen.go': 'package gen\n\nimport "example.com/tools/lib"\n\nfunc Run() { lib.Do() }\n',
  'vendor/example.com/x/x.go': 'package x\n\nfunc Vendored() {}\n',
};

const deps = (idx: SymbolIndex, id: string) => idx.dependents(id).map((s) => s.id);

describe('Go symbol index (tree-sitter, package-aware)', () => {
  let dir: string;
  let idx: SymbolIndex;
  beforeAll(() => {
    dir = writeTree(FIXTURE);
    idx = SymbolIndex.build(dir);
  });

  it('indexes funcs, methods (Recv.Method), types, consts and vars; skips vendor/', () => {
    const ids = idx.symbols().map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'store/store.go#Item',
        'store/store.go#Store',
        'store/store.go#Memory',
        'store/store.go#Memory.Get',
        'store/store.go#Base.Close',
        'store/store.go#NewMemory',
        'store/store.go#helper',
        'store/store.go#Limit',
        'store/store.go#Default',
        'api/handler.go#Handle',
        'tools/lib/lib.go#Do',
      ]),
    );
    expect(ids.some((id) => id.startsWith('vendor/'))).toBe(false);
    const get = (id: string) => idx.get(id)!;
    expect(get('store/store.go#Item')).toMatchObject({ kind: 'struct', exported: true, language: 'go' });
    expect(get('store/store.go#Store').kind).toBe('interface');
    expect(get('store/store.go#Memory.Get')).toMatchObject({ kind: 'method', exported: true });
    expect(get('store/store.go#helper').exported).toBe(false);
    expect(get('store/store.go#Limit').kind).toBe('const');
    expect(get('store/store.go#Default').kind).toBe('variable');
  });

  it('resolves unqualified same-package references across files, not shadowed ones', () => {
    expect(deps(idx, 'store/store.go#helper')).toEqual(['store/extra.go#Uses', 'store/store.go#Count']);
    const limitRefs = idx.references('store/store.go#Limit').map((r) => `${r.file}:${r.line}`);
    expect(limitRefs).toContain(`store/extra.go:${lineOf(dir, 'store/extra.go', 'return Limit // outer')}`);
    expect(limitRefs).not.toContain(`store/extra.go:${lineOf(dir, 'store/extra.go', '_ = Limit // inner')}`);
  });

  it('resolves qualified references through imports (aliases, nested go.mod modules)', () => {
    expect(deps(idx, 'store/store.go#NewMemory')).toEqual(['api/handler.go#Handle', 'store/store.go#Default']);
    expect(deps(idx, 'store/store.go#Memory')).toEqual([
      'api/handler.go#Fallback',
      'api/handler.go#Handler',
      'api/handler.go#Other',
      'store/store.go#Memory.Get',
      'store/store.go#NewMemory',
    ]);
    expect(deps(idx, 'tools/lib/lib.go#Do')).toEqual(['tools/gen/gen.go#Run']);
  });

  it('counts embedded fields and interface embedding as references', () => {
    expect(deps(idx, 'store/store.go#Store')).toEqual([
      'api/handler.go#Handler',
      'store/store.go#Count',
      'store/store.go#ReadStore',
    ]);
    expect(deps(idx, 'store/store.go#Base')).toEqual(['store/store.go#Base.Close', 'store/store.go#Memory']);
  });

  it('resolves method selectors by receiver type (inferred, param, promoted) or unique name', () => {
    // Handle: inferred from s.NewMemory(); Other: param type; Fallback: unique method name; Unknown: interface value
    expect(deps(idx, 'store/store.go#Memory.Get')).toEqual([
      'api/handler.go#Fallback',
      'api/handler.go#Handle',
      'api/handler.go#Other',
    ]);
    expect(deps(idx, 'store/store.go#Base.Close')).toEqual(['api/handler.go#Handle']); // promoted via embedded Base
  });

  it('symbolsAt maps changed lines to the enclosing declaration', () => {
    const line = lineOf(dir, 'store/store.go', 'return m.items[id], nil');
    expect(idx.symbolsAt('store/store.go', [[line, line]]).map((s) => s.id)).toEqual(['store/store.go#Memory.Get']);
    const field = lineOf(dir, 'store/store.go', 'secret int');
    expect(idx.symbolsAt('store/store.go', [[field, field]]).map((s) => s.id)).toEqual(['store/store.go#Item']);
  });

  it('detects interface changes on exported signatures only', () => {
    const changed = (edits: Record<string, (s: string) => string>) =>
      interfaceChanges(idx, SymbolIndex.build(variant(dir, edits))).map((c) => `${c.kind} ${c.id}`);
    // body / private field / comment / unexported func: no interface change
    expect(
      changed({
        'store/store.go': (s) =>
          s
            .replace('return helper()', 'return helper() + 1')
            .replace('secret int', 'secret string')
            .replace('// Item is stored.', '// Item is a stored thing.')
            .replace('func helper() int', 'func helper(x ...int) int'),
      }),
    ).toEqual([]);
    expect(
      changed({
        'store/store.go': (s) =>
          s
            .replace('Name   string `json:"name"`', 'Name   string `json:"name"`\n\tPrice  int64')
            .replace('func (m *Memory) Get(id string)', 'func (m *Memory) Get(id int)')
            .replace('Get(id string) (*Item, error)\n}', 'Get(id string) (*Item, error)\n\tPut(i *Item) error\n}'),
      }),
    ).toEqual(['changed store/store.go#Item', 'changed store/store.go#Memory.Get', 'changed store/store.go#Store']);
    expect(changed({ 'store/store.go': (s) => s.replace('json:"name"', 'json:"title"') })).toEqual([
      'changed store/store.go#Item',
    ]);
  });
});

describe('Go lease flow (coord-demo-go)', () => {
  let repo: DemoRepo;
  beforeAll(() => {
    repo = new DemoRepo(EXAMPLE);
  });

  it('indexes the demo', () => {
    const idx = SymbolIndex.build(repo.dir);
    expect(idx.dependents('types/invoice.go#Invoice').map((s) => s.id)).toEqual([
      'billing/billing.go#CreateInvoice',
      'billing/billing.go#TotalCents',
      'report/report.go#RenderReport',
      'types/invoice.go#Invoice.Dollars',
    ]);
    expect(idx.dependents('util/slug.go#Slugify')).toEqual([]);
  });

  it('leases, broadcasts interface changes to dependents and blocks conflicting edits before merge', async () => {
    repo.agentEdit(
      'agent-c',
      { 'report/report.go': (s) => s.replace('i.ID+"\\t"+i.Dollars()', 'i.ID+"\\t$"+i.Dollars()') },
      'report: dollar sign',
    );
    const c = await repo.cli('lease', 'sync', '--agent', 'agent-c', '--task', 'T-C', '--head', 'agent-c');
    expect(c.code).toBe(0);
    expect(c.out).toContain('leased report/report.go#RenderReport');

    repo.agentEdit(
      'agent-a',
      {
        'types/invoice.go': (s) =>
          s.replace(
            'AmountCents int64  `json:"amountCents"`\n',
            'AmountCents int64  `json:"amountCents"`\n\tCurrency string\n',
          ),
      },
      'types: add currency',
    );
    const a = await repo.cli('lease', 'sync', '--agent', 'agent-a', '--task', 'T-A', '--head', 'agent-a');
    expect(a.code).toBe(0);
    expect(a.out).toContain('leased types/invoice.go#Invoice');
    expect(a.out).toContain('interface changed: types/invoice.go#Invoice');
    expect(a.out).toContain('notified agent-c');
    const inbox = JSON.parse((await repo.cli('inbox', 'list', '--agent', 'agent-c', '--json')).out) as {
      notifications: { kind: string; data: { symbol: string; dependent: string; after: string } }[];
    };
    expect(inbox.notifications).toEqual([
      expect.objectContaining({
        kind: 'interface_changed',
        data: expect.objectContaining({
          symbol: 'types/invoice.go#Invoice',
          dependent: 'report/report.go#RenderReport',
          after: expect.stringContaining('Currency string'),
        }),
      }),
    ]);

    repo.agentEdit(
      'agent-b',
      {
        'types/invoice.go': (s) => s.replaceAll('AmountCents', 'Total'),
        'billing/billing.go': (s) => s.replaceAll('AmountCents', 'Total'),
      },
      'rename AmountCents -> Total',
    );
    const b = await repo.cli('lease', 'sync', '--agent', 'agent-b', '--task', 'T-B', '--head', 'agent-b');
    expect(b.code).toBe(1);
    expect(b.out).toContain('CONFLICT types/invoice.go#Invoice is leased by agent-a for T-A');
    const check = await repo.cli('lease', 'check', '--agent', 'agent-b', '--task', 'T-B', '--head', 'agent-b');
    expect(check.code).toBe(1);
    expect(check.out).toContain('CONFLICT types/invoice.go#Invoice');
    expect((await repo.cli('lease', 'list')).out).not.toContain('agent-b');
    expect((await repo.cli('lease', 'check', '--agent', 'agent-a', '--task', 'T-A', '--head', 'agent-a')).code).toBe(0);
  });
});
