import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TOOLCHAINS,
  defaultPrepare,
  detectToolchain,
  findManifests,
  inRoot,
  isToolchainSourceFile,
  isToolchainTestFile,
} from '@sluice-dev/lang';

const mk = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'sluice-tc-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  return d;
};

describe('toolchains: prepare and file roles', () => {
  it('finds dependency manifests, skipping build output and vendored trees', () => {
    const d = mk({
      'go.mod': 'module m\n',
      'go.sum': '',
      'vendor/x/go.mod': '',
      'App/App.csproj': '',
      'App/obj/project.assets.json': '',
      'App/bin/Debug/x.csproj': '',
      'web/package.json': '{}',
      'node_modules/a/package.json': '{}',
      'main.go': '',
    });
    expect(findManifests(d)).toEqual(['App/App.csproj', 'go.mod', 'go.sum', 'web/package.json']);
    expect(findManifests(d, TOOLCHAINS.go)).toEqual(['go.mod', 'go.sum']);
  });

  it('defaults prepare for Go modules and .NET projects, never for Node', () => {
    expect(defaultPrepare(TOOLCHAINS.go, mk({ 'go.mod': 'module m\n\nrequire x.io/y v1.0.0\n' }))).toBe(
      TOOLCHAINS.go.prepareCommand,
    );
    expect(defaultPrepare(TOOLCHAINS.go, mk({ 'svc/go.mod': 'module m\n' }))).toBe(TOOLCHAINS.go.prepareCommand);
    expect(defaultPrepare(TOOLCHAINS.go, mk({ 'main.go': '' }))).toBeUndefined();
    expect(defaultPrepare(TOOLCHAINS.dotnet, mk({ 'A.sln': '', 'src/A/A.csproj': '' }))).toBe(
      TOOLCHAINS.dotnet.prepareCommand,
    );
    expect(defaultPrepare(TOOLCHAINS.dotnet, mk({ 'global.json': '{}' }))).toBeUndefined();
    expect(defaultPrepare(TOOLCHAINS.node, mk({ 'package.json': '{"dependencies":{"a":"1"}}' }))).toBeUndefined();
    expect(defaultPrepare(undefined, mk({ 'go.mod': '' }))).toBeUndefined();
  });

  it('prepare commands are valid POSIX sh and walk every module/project', () => {
    for (const t of Object.values(TOOLCHAINS)) execFileSync('sh', ['-n', '-c', t.prepareCommand]);
    // dry run: replace the tool with echo and run from a manifest-only tree
    const d = mk({ 'go.mod': '', 'b/go.mod': '', 'vendor/c/go.mod': '', 'A/A.csproj': '', 'T/T.Tests.fsproj': '' });
    const run = (cmd: string) => execFileSync('sh', ['-c', cmd], { cwd: d }).toString().trim().split('\n');
    const goDirs = run(TOOLCHAINS.go.prepareCommand.replace('go mod download && go build std', 'basename "$PWD"'));
    expect(goDirs).toHaveLength(2); // vendor/ skipped
    expect(goDirs[0]).toBe('b');
    expect(run(TOOLCHAINS.dotnet.prepareCommand.replace('dotnet restore', 'echo'))).toEqual([
      './A/A.csproj',
      './T/T.Tests.fsproj',
    ]);
  });

  it('detects the project root one level down', () => {
    expect(detectToolchain(mk({ 'go.mod': '', 'backend/go.mod': '' }))).toMatchObject({ id: 'go', root: '.' });
    expect(detectToolchain(mk({ 'backend/go.mod': '', 'README.md': '' }))).toMatchObject({ id: 'go', root: 'backend' });
    expect(detectToolchain(mk({ 'Api/Api.csproj': '' }))).toMatchObject({ id: 'dotnet', root: 'Api' });
    // a child holding a solution wins over project-only children
    expect(detectToolchain(mk({ 'App/App.csproj': '', 'svc/Svc.slnx': '', 'svc/A/A.csproj': '' }))).toMatchObject({
      id: 'dotnet',
      root: 'svc',
    });
    // ambiguous: several candidate children -> root stays '.'
    expect(detectToolchain(mk({ 'App/App.csproj': '', 'App.Tests/App.Tests.csproj': '' }))).toMatchObject({
      id: 'dotnet',
      root: '.',
    });
    expect(inRoot('.', 'go test ./...')).toBe('go test ./...');
    expect(inRoot('backend', 'go test ./...')).toBe('cd backend && go test ./...');
    expect(inRoot("my app's", 'x')).toBe(`cd 'my app'\\''s' && x`);
    expect(
      execFileSync('sh', ['-c', inRoot("my app's", 'basename "$PWD"')], { cwd: mk({ "my app's/x": '' }) }).toString(),
    ).toBe("my app's\n");
  });

  it('classifies test and source files per toolchain', () => {
    expect(isToolchainTestFile(TOOLCHAINS.go, 'pkg/a_test.go')).toBe(true);
    expect(isToolchainTestFile(TOOLCHAINS.go, 'test/a.test.js')).toBe(false);
    expect(isToolchainTestFile(TOOLCHAINS.dotnet, 'tests/App.Tests/CartTests.cs')).toBe(true);
    expect(isToolchainTestFile(TOOLCHAINS.dotnet, 'tests/App.Tests/App.Tests.csproj')).toBe(false);
    expect(isToolchainTestFile(undefined, 'test/a.test.js')).toBe(true);
    expect(isToolchainSourceFile(TOOLCHAINS.go, 'pkg/a.go')).toBe(true);
    expect(isToolchainSourceFile(TOOLCHAINS.go, 'pkg/a_test.go')).toBe(false);
    expect(isToolchainSourceFile(TOOLCHAINS.go, 'README.md')).toBe(false);
    expect(isToolchainSourceFile(TOOLCHAINS.dotnet, 'src/App/Cart.cs')).toBe(true);
    expect(isToolchainSourceFile(TOOLCHAINS.node, 'src/App/Cart.cs')).toBe(false);
  });
});
