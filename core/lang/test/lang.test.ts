import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TOOLCHAINS,
  detectToolchain,
  goModulePath,
  isDependencyManifest,
  isTestFile,
  languageOf,
  listSourceFiles,
  parseSource,
} from '../src/index.js';

describe('@sluice-dev/lang', () => {
  it('maps extensions to languages', () => {
    expect(languageOf('a/b.go')).toBe('go');
    expect(languageOf('A.cs')).toBe('csharp');
    expect(languageOf('x.tsx')).toBe('typescript');
    expect(languageOf('x.d.ts')).toBeUndefined();
    expect(languageOf('x.mjs')).toBe('javascript');
    expect(languageOf('README.md')).toBeUndefined();
  });

  it('parses Go and C# with tree-sitter', () => {
    const go = parseSource('go', 'package main\nfunc Add(a, b int) int { return a + b }\n').root();
    expect(go.find('return $A + $B')?.getMatch('A')?.text()).toBe('a');
    expect(
      go
        .find({ rule: { kind: 'function_declaration' } } as never)
        ?.field('name')
        ?.text(),
    ).toBe('Add');
    const cs = parseSource('csharp', 'namespace N; public class C { public int M(int a) => a + 2; }').root();
    expect(
      cs
        .find({ rule: { kind: 'class_declaration' } } as never)
        ?.field('name')
        ?.text(),
    ).toBe('C');
    expect(cs.find('$A + $B')?.text()).toBe('a + 2');
  });

  it('lists source files, skipping vendored and build output per language', () => {
    const d = mkdtempSync(join(tmpdir(), 'sluice-lang-'));
    for (const f of [
      'main.go',
      'vendor/x/y.go',
      'pkg/testdata/z.go',
      'App/C.cs',
      'App/bin/G.cs',
      'App/obj/G.cs',
      'bin/cli.js',
      'node_modules/m/i.js',
    ]) {
      mkdirSync(join(d, f, '..'), { recursive: true });
      writeFileSync(join(d, f), '');
    }
    expect(listSourceFiles(d)).toEqual(['App/C.cs', 'bin/cli.js', 'main.go']);
    expect(listSourceFiles(d, ['go'])).toEqual(['main.go']);
  });

  it('detects toolchains and manifests', () => {
    const mk = (files: string[]) => {
      const d = mkdtempSync(join(tmpdir(), 'sluice-tc-'));
      for (const f of files) {
        mkdirSync(join(d, f, '..'), { recursive: true });
        writeFileSync(join(d, f), '');
      }
      return d;
    };
    expect(detectToolchain(mk(['go.mod']))?.id).toBe('go');
    expect(detectToolchain(mk(['Billing.sln']))?.id).toBe('dotnet');
    expect(detectToolchain(mk(['src/Api/Api.csproj']))).toBeUndefined();
    expect(detectToolchain(mk(['Api/Api.csproj']))?.id).toBe('dotnet');
    expect(detectToolchain(mk(['package.json']))?.id).toBe('node');
    expect(detectToolchain(mk(['x.txt']))).toBeUndefined();
    // tooling-only root package.json next to one Go/.NET project → the project wins
    expect(detectToolchain(mk(['package.json', 'prettier.config.js', 'backend/go.mod']))).toMatchObject({
      id: 'go',
      root: 'backend',
    });
    expect(detectToolchain(mk(['package.json', 'Api/Api.csproj', 'Api/wwwroot/site.js']))).toMatchObject({
      id: 'dotnet',
      root: 'Api',
    });
    // real JS sources at the root keep node
    expect(detectToolchain(mk(['package.json', 'src/index.ts', 'backend/go.mod']))?.id).toBe('node');
    expect(detectToolchain(mk(['package.json', 'a/go.mod', 'b/go.mod']))?.id).toBe('node');
    expect(isDependencyManifest('svc/go.sum')).toBe(true);
    expect(isDependencyManifest('src/Api/Api.csproj')).toBe(true);
    expect(isDependencyManifest('Directory.Packages.props')).toBe(true);
    expect(isDependencyManifest('package-lock.json')).toBe(true);
    expect(isDependencyManifest('src/api.go')).toBe(false);
    expect(TOOLCHAINS.go.image).toMatch(/^golang:/);
    expect(goModulePath('module example.com/billing\n\ngo 1.27\n')).toBe('example.com/billing');
  });

  it('recognizes test files by convention', () => {
    expect(isTestFile('billing_test.go')).toBe(true);
    expect(isTestFile('billing.go')).toBe(false);
    expect(isTestFile('Billing.Tests/CancelTests.cs')).toBe(true);
    expect(isTestFile('Billing/Cancel.cs')).toBe(false);
    expect(isTestFile('test/cancel.test.js')).toBe(true);
    expect(isTestFile('src/billing.js')).toBe(false);
  });
});
