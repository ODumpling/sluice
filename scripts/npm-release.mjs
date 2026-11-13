#!/usr/bin/env node
// npm release helper for the @sluice-dev/* packages (no long-lived tokens).
//
//   node scripts/npm-release.mjs publish [--dry-run]
//       Packs every package with pnpm (workspace:* -> real versions) and runs
//       `npm publish <tarball>`; versions already on the registry are skipped,
//       so re-runs are safe. In GitHub Actions npm authenticates with the
//       workflow's OIDC identity (Trusted Publishing). Locally it uses your
//       `npm login` session (browser sign-in).
//
//   node scripts/npm-release.mjs trust [--dry-run]
//   (both accept --otp=<code>; run them in an interactive terminal so npm can open the browser for 2FA)
//       One-time, after the first publish: registers .github/workflows/release.yml
//       in ODumpling/sluice as the trusted publisher of every package
//       (`npm trust github`, npm >= 11.15, 2FA on your account).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const REPO = 'ODumpling/sluice';
const WORKFLOW = 'release.yml';
const [mode, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
// Pass-through for a 2FA code from an authenticator app (--otp=123456); otherwise npm prompts / opens the browser.
const otp = flags.find((f) => f.startsWith('--otp='));

const packages = ['core', 'plugins', 'surfaces'].flatMap((group) =>
  readdirSync(join(root, group))
    .map((d) => join(root, group, d))
    .filter((d) => existsSync(join(d, 'package.json')))
    .map((dir) => ({ dir, ...JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }))
    .filter((p) => !p.private),
);

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts })
    .toString()
    .trim();

function npmVersionAtLeast(min) {
  const v = sh('npm', ['--version']).split('.').map(Number);
  const m = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((v[i] ?? 0) !== m[i]) return (v[i] ?? 0) > m[i];
  return true;
}

function published(name, version) {
  try {
    return sh('npm', ['view', `${name}@${version}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] }) === version;
  } catch {
    return false;
  }
}

if (mode === 'publish') {
  if (!npmVersionAtLeast('11.5.1'))
    throw new Error('npm >= 11.5.1 is required for trusted publishing (npm install -g npm@latest)');
  const out = mkdtempSync(join(tmpdir(), 'sluice-release-'));
  for (const p of packages) {
    if (published(p.name, p.version)) {
      console.log(`skip ${p.name}@${p.version} (already on npm)`);
      continue;
    }
    sh('pnpm', ['pack', '--pack-destination', out], { cwd: p.dir });
    const tgz = readdirSync(out).find((f) => f.startsWith(p.name.replace('@', '').replace('/', '-') + '-' + p.version));
    if (!tgz) throw new Error(`pack produced no tarball for ${p.name}`);
    const args = [
      'publish',
      join(out, tgz),
      '--access',
      'public',
      ...(dryRun ? ['--dry-run'] : []),
      ...(otp ? [otp] : []),
    ];
    console.log(`npm ${args.join(' ')}`);
    execFileSync('npm', args, { stdio: 'inherit' });
  }
} else if (mode === 'trust') {
  if (!npmVersionAtLeast('11.15.0')) throw new Error('`npm trust` needs npm >= 11.15.0 (npm install -g npm@latest)');
  for (const p of packages) {
    const args = [
      'trust',
      'github',
      p.name,
      '--file',
      WORKFLOW,
      '--repo',
      REPO,
      '--allow-publish',
      '--yes',
      ...(dryRun ? ['--dry-run'] : []),
      ...(otp ? [otp] : []),
    ];
    console.log(`npm ${args.join(' ')}`);
    execFileSync('npm', args, { stdio: 'inherit' });
  }
} else {
  console.error('usage: npm-release.mjs publish|trust [--dry-run]');
  process.exit(2);
}
