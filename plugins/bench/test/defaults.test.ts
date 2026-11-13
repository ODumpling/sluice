import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOLCHAINS } from '@sluice-dev/lang';
import { resolveMining, taskRunOptions, type MineOptions } from '@sluice-dev/plugin-bench';

function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'sluice-bench-defaults-'));
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), t);
  }
  const g = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  return d;
}
const opts = (repoDir: string, o: Partial<MineOptions> = {}): MineOptions => ({ repoDir, repo: 'x/y', limit: 5, ...o });

describe('bench mining defaults', () => {
  it('Go: image, test command, test files and prepare from the detected toolchain', async () => {
    const m = await resolveMining(opts(repo({ 'go.mod': 'module x\n', 'a.go': '', 'a_test.go': '' })));
    expect(m.toolchain?.id).toBe('go');
    expect(m).toMatchObject({ image: TOOLCHAINS.go.image, testCommand: 'go test ./...' });
    expect(m.prepare).toBe(TOOLCHAINS.go.prepareCommand);
    expect([m.isTest('pkg/a_test.go'), m.isTest('pkg/a.go'), m.isSource('pkg/a.go'), m.isSource('go.mod')]).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('.NET: test projects hold the hidden tests; restore is the prepare step', async () => {
    const m = await resolveMining(
      opts(repo({ 'App.sln': '', 'src/App/App.csproj': '', 'tests/App.Tests/App.Tests.csproj': '' })),
    );
    expect(m).toMatchObject({ image: TOOLCHAINS.dotnet.image, testCommand: 'dotnet test --nologo' });
    expect(m.prepare).toBe(TOOLCHAINS.dotnet.prepareCommand);
    expect(m.env).toMatchObject({ DOTNET_CLI_TELEMETRY_OPTOUT: '1' });
    expect(m.isTest('tests/App.Tests/CartTests.cs')).toBe(true);
    expect(m.isSource('src/App/Cart.cs')).toBe(true);
    expect(m.isSource('tests/App.Tests/CartTests.cs')).toBe(false);
  });

  it('nested project roots: defaults run at backend/ (Go module) and Api/ (.NET project, no solution)', async () => {
    const go = await resolveMining(opts(repo({ 'backend/go.mod': 'module x\n', 'backend/a.go': '', 'docs/x.md': '' })));
    expect(go.testCommand).toBe('cd backend && go test ./...');
    expect(go.prepare).toBe(`cd backend && ${TOOLCHAINS.go.prepareCommand}`);
    const dn = await resolveMining(opts(repo({ 'Api/Api.csproj': '', 'Api/Program.cs': '' }), { prepare: true }));
    expect(dn.testCommand).toBe('cd Api && dotnet test --nologo');
    expect(dn.prepare).toBe(`cd Api && ${TOOLCHAINS.dotnet.prepareCommand}`);
    // an explicit test command runs from the repository root, as written
    const explicit = await resolveMining(opts(repo({ 'backend/go.mod': 'module x\n' }), { testCommand: 'make test' }));
    expect(explicit.testCommand).toBe('make test');
  });

  it('Node keeps explicit settings and gets no prepare unless asked', async () => {
    const d = repo({ 'package.json': '{}', 'lib/a.js': '' });
    const explicit = await resolveMining(
      opts(d, {
        source: ['lib/'],
        tests: '^test/.*\\.test\\.js$',
        testCommand: 'node --test',
        image: 'node:22-alpine',
      }),
    );
    expect(explicit).toMatchObject({ image: 'node:22-alpine', testCommand: 'node --test', prepare: undefined });
    expect(explicit.env).toBeUndefined();
    expect(taskRunOptions(explicit)).toEqual({ env: undefined, prepare: undefined });
    expect((await resolveMining(opts(d, { prepare: true }))).prepare).toBe(TOOLCHAINS.node.prepareCommand);
    expect((await resolveMining(opts(d, { prepare: 'make deps' }))).prepare).toBe('make deps');
  });

  it('needs a test command when no toolchain is detected', async () => {
    await expect(resolveMining(opts(repo({ 'x.txt': '' })))).rejects.toThrow(/set mine.testCommand/);
    const go = await resolveMining(opts(repo({ 'go.mod': 'module x\n' }), { prepare: false }));
    expect(go.prepare).toBeUndefined();
    const run = taskRunOptions({ prepare: 'go mod download' });
    expect(run?.prepare?.manifest('svc/go.sum')).toBe(true);
    expect(run?.prepare?.manifest('svc/main.go')).toBe(false);
  });
});
