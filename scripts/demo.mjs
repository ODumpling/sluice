#!/usr/bin/env node
// `pnpm demo` — the Sluice north-star demo, from a clean clone, in one command.
// Needs Node >= 22.13, pnpm and a running Docker daemon. No network calls are
// made by the demo itself (Docker images / npm packages are fetched on first run).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const step = (msg) => process.stdout.write(`\n\x1b[1m▸ ${msg}\x1b[0m\n`);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' }).status !== 0) {
  console.error('sluice demo: Docker is not running (or not installed). Start Docker and retry.');
  process.exit(1);
}
if (!existsSync(join(root, 'node_modules', '.pnpm'))) {
  step('installing dependencies');
  run('pnpm', ['install', '--frozen-lockfile']);
}
if (!existsSync(join(root, 'surfaces', 'cli', 'dist', 'index.js')) || process.env.SLUICE_DEMO_REBUILD) {
  step('building');
  run('pnpm', ['build']);
}

const { runCli } = await import('@sluice-dev/cli');
const { FakeServer, GitHubFake, SimClock } = await import('@sluice-dev/fakes');
const { PRS, commitAll, createPrBranch, initDemoRepo } = await import('./demo/demo-repo.mjs');

const io = (cwd, env = {}) => ({
  cwd,
  env: { ...process.env, ...env },
  stdout: { write: (t) => process.stdout.write(t) },
  stderr: { write: (t) => process.stderr.write(t) },
});

const clock = new SimClock(Date.UTC(2030, 0, 15, 12));
const github = new GitHubFake({ clock });
const gh = new FakeServer(github, { clock });
await gh.start();
github.createRepo({ owner: 'acme', name: 'billing-demo' });
github.issueToken('ghs_demo', {
  login: 'github-actions[bot]',
  repos: ['acme/billing-demo'],
  permissions: { checks: 'write', metadata: 'read' },
});
const ghEnv = { GITHUB_API_URL: gh.url, GITHUB_TOKEN: 'ghs_demo', GITHUB_REPOSITORY: 'acme/billing-demo' };

step('creating demo repo: billing-demo (Node + Postgres + fake Stripe) with ticket CANCEL-1');
const repo = initDemoRepo();
console.log(`  ${repo}`);
await runCli(['gate', 'status', 'CANCEL-1'], io(repo));

step('1. a human approves the 5 acceptance scenarios');
await runCli(['gate', 'approve', 'CANCEL-1', '--as', 'product-owner@acme.test'], io(repo));
commitAll(repo, 'CANCEL-1: approve acceptance scenarios');

step('2. two agents open PRs (both include passing unit tests)');
for (const k of ['bad', 'good']) {
  const { files } = createPrBranch(repo, PRS[k]);
  console.log(`  ${PRS[k].branch}: ${PRS[k].title} (${files.join(', ')})`);
}

const results = {};
for (const [k, label] of [
  ['bad', '3. gate on the PR that cancels immediately'],
  ['good', '4. gate on the PR that cancels at period end'],
]) {
  step(`${label} (${PRS[k].branch})`);
  results[k] = await runCli(
    ['gate', 'run', '--ticket', 'CANCEL-1', '--base', 'main', '--head', PRS[k].branch, '--github-check'],
    io(repo, ghEnv),
  );
}

step('GitHub checks posted (to the GitHub fake)');
for (const c of github.checkRuns('acme/billing-demo')) {
  console.log(`  ${c.conclusion === 'success' ? '✔' : '✘'} ${c.name} @ ${c.head_sha.slice(0, 8)}: ${c.output.title}`);
}
await gh.stop();

const ok = results.bad === 1 && results.good === 0;
console.log(
  `\n${ok ? '\x1b[32m✔ demo complete' : '\x1b[31m✘ demo did not produce the expected verdicts'}\x1b[0m — reports in ${join(repo, '.sluice', 'reports')}`,
);
if (process.env.SLUICE_DEMO_KEEP !== '1') execFileSync('git', ['worktree', 'prune'], { cwd: repo });
process.exit(ok ? 0 : 1);
