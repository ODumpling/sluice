import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSource, type Language } from '@sluice-dev/lang';
import { describe, expect, it } from 'vitest';
import { applyMutant, generateMutants, type Mutant } from '../src/mutation.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'mutation');
const ALL: [number, number][] = [[1, 100_000]];

const show = (ms: Mutant[]) => ms.map((m) => `${m.line}:${m.operator}:${m.original}->${m.replacement}`);
const shown = (file: string, text: string, ranges = ALL) => show(generateMutants(file, text, ranges));

/** No tree-sitter ERROR / MISSING nodes. */
function syntaxErrors(language: Language, text: string): string[] {
  const errs: string[] = [];
  const walk = (n: ReturnType<ReturnType<typeof parseSource>['root']>) => {
    if (n.kind() === 'ERROR' || (n.isLeaf() && n.text() === '' && n.range().start.index !== n.range().end.index))
      errs.push(`${n.range().start.line + 1}: ${n.text().slice(0, 60)}`);
    for (const c of n.children()) walk(c);
  };
  walk(parseSource(language, text).root());
  return errs;
}

const has = (bin: string) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0;
const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;
const hasDotnet = process.env.SLUICE_TEST_DOTNET === '1' && has('dotnet');

// ------------------------------------------------------------------ Go

const GO = `package p

import "strings"

type Box struct {
	N int \`json:"n"\`
}

func F(a, b int, s string) (int, error) {
	if a == b && !strings.HasPrefix(s, "x") {
		return a * 2, nil
	}
	m := map[string]bool{"k": true}
	log(s+"!", m)
	return a - b/3, nil
}
`;

describe('Go mutants', () => {
  it('covers every operator, only on changed lines', () => {
    expect(shown('p/f.go', GO, [[10, 15]])).toEqual([
      '10:negate-condition:a == b && !strings.HasPrefix(s, "x")->!(a == b && !strings.HasPrefix(s, "x"))',
      '10:binary-operator:==->!=',
      '10:binary-operator:&&->||',
      '10:remove-negation:!->',
      '10:string-literal:"x"->""',
      '11:return-value:a * 2->0',
      '11:binary-operator:*->/',
      '11:numeric-literal:2->3',
      '13:boolean-literal:true->false', // the map key "k" is left alone
      '14:remove-call:log(s+"!", m)->if false { log(s+"!", m) }', // `s+"!"` is a string: no `-`
      '14:string-literal:"!"->""',
      '15:return-value:a - b/3->0',
      '15:binary-operator:-->+',
      '15:binary-operator:/->*',
      '15:numeric-literal:3->4',
    ]);
    expect(shown('p/f.go', GO, [[1, 7]])).toEqual([]); // import path, struct tag
    expect(shown('p/f.go', GO, [[13, 13]])).toEqual(['13:boolean-literal:true->false']);
  });

  it('returns the zero value of the declared result type', () => {
    const src = `package p

type Status int
type Label string
type Inv struct{ ID string }
type Store interface{ Get() }

func a() int { return n }
func b() string { return s }
func c() bool { return ok }
func d() error { return err }
func e() *Inv { return p }
func f() []int { return xs }
func g() map[string]int { return mp }
func h() Status { return st }
func i() Label { return lb }
func j() Inv { return Inv{ID: "x"} }
func k() Store { return sv }
func l() Other { return o }
func m() (Inv, error) { return v, nil }
func n2() (x, y int) { return 1, 2 }
func o2() (int, error) { return pair() }
func q[T any]() T { return t }
func r() func() bool { return func() bool { return ok } }
func s2() float64 { return 0 }
`;
    expect(
      generateMutants('p/z.go', src, ALL)
        .filter((m) => m.operator === 'return-value')
        .map((m) => `${m.original}->${m.replacement}`),
    ).toEqual([
      'n->0',
      's->""',
      'ok->false',
      'err->nil',
      'p->nil',
      'xs->nil',
      'mp->nil',
      'st->0', // named types declared in the file resolve to their underlying zero value
      'lb->""',
      'Inv{ID: "x"}->Inv{}',
      'sv->nil',
      // l(): Other is not declared in this file — skipped
      'v->Inv{}', // multi-value: first result only
      '1->0',
      // o2(): a multi-value call is skipped; q(): a type parameter has no literal zero value
      'func() bool { return ok }->nil',
      'ok->false',
      // s2(): already the zero value
    ]);
  });

  it('avoids mutants that cannot compile', () => {
    const lines = [
      'package p', // 1
      'import ("errors"; "fmt")',
      'func a(n int, s string) string {',
      '	switch n {',
      '	case 1:', // 5: 1 -> 2 would duplicate case 2
      '		return "one"',
      '	case 2:',
      '	}',
      '	switch s {',
      '	case "a", "":', // 10: "a" -> "" would duplicate case ""
      '	}',
      '	var arr [3]int', // 12: array length
      '	arr[2] = 7', // 13: constant index (7 -> 8 is fine)
      '	_ = arr[1:2]', // 14: slice bounds
      '	var b byte = 255', // 15: overflow
      '	var c int8 = -128', // 16: overflow
      '	_, _ = b, c',
      '	t := s + "x"', // 18: string concatenation has no `-`
      '	_ = t + s', // 19: t is a string
      '	_ = n * 0', // 20: division by constant zero
      '	only := fmt.Sprint(n)',
      '	return only', // 22: last use of a local
      '}',
      'func z() error {',
      '	return errors.New("x")', // 25: last use of an import
      '}',
      'func must(ok bool) int {',
      '	if ok {',
      '		return 1',
      '	}',
      '	panic("no")', // 31: terminating statement
      '}',
    ];
    const ms = shown('p/a.go', lines.join('\n') + '\n');
    const on = (from: number, to = from) =>
      ms.filter((m) => {
        const l = Number(m.split(':')[0]);
        return l >= from && l <= to;
      });
    expect(on(5)).toEqual([]);
    expect(on(7)).toEqual(['7:numeric-literal:2->3']);
    expect(on(10)).toEqual([]);
    expect(on(12, 16)).toEqual(['13:numeric-literal:7->8']);
    expect(on(18, 20)).toEqual(['18:string-literal:"x"->""', '20:numeric-literal:0->1']);
    expect(on(22)).toEqual([]);
    expect(on(25)).toEqual(['25:string-literal:"x"->""']);
    expect(on(31)).toEqual(['31:string-literal:"no"->""']);
  });

  it('applies mutants of the fixture; each one parses cleanly', () => {
    const src = readFileSync(join(FIXTURES, 'fix.go'), 'utf8');
    const all = generateMutants('fix.go', src, ALL);
    expect(new Set(all.map((m) => m.operator))).toEqual(
      new Set([
        'binary-operator',
        'boolean-literal',
        'remove-negation',
        'string-literal',
        'numeric-literal',
        'negate-condition',
        'remove-call',
        'return-value',
      ]),
    );
    for (const m of all) {
      const out = applyMutant(src, m);
      expect(out).not.toBe(src);
      expect(syntaxErrors('go', out), `${m.id} ${m.original} -> ${m.replacement}`).toEqual([]);
    }
  });

  it.skipIf(!hasGo)(
    'every mutant of the fixture compiles (go build)',
    () => {
      const src = readFileSync(join(FIXTURES, 'fix.go'), 'utf8');
      const all = generateMutants('fix.go', src, ALL);
      const dir = mkdtempSync(join(tmpdir(), 'sluice-go-mutants-'));
      try {
        writeFileSync(join(dir, 'go.mod'), 'module example.com/mutants\n\ngo 1.22\n');
        all.forEach((m, i) => {
          mkdirSync(join(dir, `m${i}`));
          writeFileSync(join(dir, `m${i}`, 'fix.go'), applyMutant(src, m));
        });
        const r = spawnSync('go', ['build', './...'], {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOWORK: 'off' },
        });
        const bad = [...new Set([...r.stderr.matchAll(/m(\d+)[\\/]fix\.go/g)].map((x) => Number(x[1])))].map(
          (i) => `${all[i]!.line}:${all[i]!.operator}: ${all[i]!.original} -> ${all[i]!.replacement}`,
        );
        expect(bad, r.stderr).toEqual([]);
        expect(r.status, r.stderr).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

// ------------------------------------------------------------------ C#

const CS = `using System;

public class C
{
    [Obsolete("old")]
    public int F(int a, int b, string s)
    {
        if (a == b && !s.StartsWith("x"))
        {
            return a * 2;
        }
        var d = new System.Collections.Generic.Dictionary<string, bool> { ["k"] = true };
        Log(s + "!", d);
        return a - b / 3;
    }
    public int P => 42;
    void Log(string s, object o) { }
}
`;

describe('C# mutants', () => {
  it('covers every operator, only on changed lines', () => {
    expect(shown('src/C.cs', CS, [[8, 16]])).toEqual([
      '8:negate-condition:a == b && !s.StartsWith("x")->!(a == b && !s.StartsWith("x"))',
      '8:binary-operator:==->!=',
      '8:binary-operator:&&->||',
      '8:remove-negation:!->',
      '8:string-literal:"x"->""',
      '10:return-value:a * 2->default!',
      '10:binary-operator:*->/',
      '10:numeric-literal:2->3',
      '12:boolean-literal:true->false', // the index key "k" is left alone
      '13:remove-call:Log(s + "!", d);->;', // `s + "!"` is a string: no `-`
      '13:string-literal:"!"->""',
      '14:return-value:a - b / 3->default!',
      '14:binary-operator:-->+',
      '14:binary-operator:/->*',
      '14:numeric-literal:3->4',
      '16:numeric-literal:42->43',
      '16:return-value:42->default!', // expression-bodied member
    ]);
    expect(shown('src/C.cs', CS, [[1, 6]])).toEqual([]); // using, attribute arguments
  });

  it('avoids mutants that cannot compile', () => {
    const src = `using System;
using System.Linq;

class C
{
    string Kind(int n, object o, DateTime t)
    {
        switch (n) { case 1: return "one"; case 2: return o is "a" or "" ? "" : "b"; }
        if (o is string str && str.Length > 0) return str;
        if (Map.TryGetValue("a", out var v)) Use(v);
        Init(out int w);
        byte b = 255;
        int big = -2147483648;
        var age = DateTime.UtcNow - t;
        var f = new[] { 1 }.Select(x => { return x + 1; });
        var bytes = "abc"u8;
        return $"{n}";
    }
    void Save() => Console.WriteLine();
    async System.Threading.Tasks.Task Go() => await System.Threading.Tasks.Task.Yield();
    ref int R() { return ref _x; }
    void U() { app.Use(async (ctx, next) => { await next(ctx); Log(); }); }
}
`;
    const ms = shown('C.cs', src);
    expect(ms).not.toContain('8:numeric-literal:1->2'); // duplicate case 2
    expect(ms).not.toContain('8:string-literal:"a"->""'); // duplicate pattern ""
    expect(ms.filter((m) => m.startsWith('9:negate-condition') || m.startsWith('9:binary-operator:&&'))).toEqual([]);
    expect(ms.filter((m) => m.startsWith('10:negate-condition'))).toEqual([]); // out var
    expect(ms.filter((m) => m.startsWith('11:remove-call'))).toEqual([]); // out argument
    expect(ms.filter((m) => /^1[23]:numeric/.test(m))).toEqual([]); // byte/int overflow
    expect(ms.filter((m) => m.startsWith('14:binary'))).toEqual([]); // DateTime - DateTime
    expect(ms.filter((m) => m.startsWith('15:return-value'))).toEqual([]); // lambda return type inference
    expect(ms.filter((m) => m.startsWith('16:'))).toEqual([]); // UTF-8 literal
    expect(ms).toContain('17:string-literal:$"{n}"->""');
    expect(ms.filter((m) => /^(19|20|21):return-value/.test(m))).toEqual([]); // void, async Task, ref
    // a lambda's use of its parameters can select the overload it binds to
    expect(ms.filter((m) => m.startsWith('22:remove-call'))).toEqual([
      '22:remove-call:app.Use(async (ctx, next) => { await next(ctx); Log(); });->;',
      '22:remove-call:Log();->;', // not `await next(ctx);`
    ]);
  });

  it('applies mutants of the fixture; each one parses cleanly', () => {
    const src = readFileSync(join(FIXTURES, 'Fix.cs'), 'utf8');
    const all = generateMutants('Fix.cs', src, ALL);
    expect(new Set(all.map((m) => m.operator)).size).toBe(8);
    for (const m of all) {
      const out = applyMutant(src, m);
      expect(out).not.toBe(src);
      expect(syntaxErrors('csharp', out), `${m.id} ${m.original} -> ${m.replacement}`).toEqual([]);
    }
  });

  // dotnet build is ~1-10s: opt in with SLUICE_TEST_DOTNET=1
  it.skipIf(!hasDotnet)(
    'every mutant of the fixture compiles (dotnet build)',
    () => {
      const src = readFileSync(join(FIXTURES, 'Fix.cs'), 'utf8');
      const all = generateMutants('Fix.cs', src, ALL);
      const dir = mkdtempSync(join(tmpdir(), 'sluice-cs-mutants-'));
      try {
        writeFileSync(
          join(dir, 'mutants.csproj'),
          '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>\n',
        );
        all.forEach((m, i) => {
          const text = applyMutant(src, m).replace(/^((?:using [^\n]*\n)*)/, `$1namespace M${i} {\n`) + '\n}\n';
          writeFileSync(join(dir, `M${i}.cs`), text);
        });
        const r = spawnSync('dotnet', ['build', '-nologo', '-v', 'q'], { cwd: dir, encoding: 'utf8' });
        const bad = [...new Set([...r.stdout.matchAll(/M(\d+)\.cs\(\d+,\d+\): error/g)].map((x) => Number(x[1])))].map(
          (i) => `${all[i]!.line}:${all[i]!.operator}: ${all[i]!.original} -> ${all[i]!.replacement}`,
        );
        expect(bad, r.stdout).toEqual([]);
        expect(r.status, r.stdout).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe('generated code', () => {
  it('skips generated Go/C# files', () => {
    expect(
      generateMutants('x.go', '// Code generated by protoc. DO NOT EDIT.\n\npackage p\n\nvar x = 1\n', ALL),
    ).toEqual([]);
    expect(generateMutants('X.cs', '// <auto-generated/>\nclass X { int y = 1; }\n', ALL)).toEqual([]);
  });
});
