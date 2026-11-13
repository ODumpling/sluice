// Builds the north-star demo repository: billing-demo on `main` with ticket
// CANCEL-1 and its 5 proposed scenarios, plus two agent PR branches.
// Used by `pnpm demo` and by test/e2e/north-star.itest.ts.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

export const EXAMPLE = join(import.meta.dirname, '..', '..', 'examples', 'billing-demo');
export const PRS = {
  bad: {
    branch: 'agent/cancel-immediately',
    overlay: join(EXAMPLE, 'prs', 'bad-immediate-cancel'),
    title: 'Add subscription cancellation (CANCEL-1)',
  },
  good: {
    branch: 'agent/cancel-at-period-end',
    overlay: join(EXAMPLE, 'prs', 'good-period-end-cancel'),
    title: 'Cancel at period end (CANCEL-1)',
  },
};
const EXCLUDE = new Set(['node_modules', 'prs', 'sessions', 'reports']);

export function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

/** New git repo with billing-demo committed on main. Returns the repo path. */
export function initDemoRepo(parent = mkdtempSync(join(tmpdir(), 'sluice-demo-'))) {
  const repo = join(parent, 'billing-demo');
  cpSync(EXAMPLE, repo, {
    recursive: true,
    filter: (src) =>
      !relative(EXAMPLE, src)
        .split(/[\\/]/)
        .some((seg) => EXCLUDE.has(seg)),
  });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'dev@acme.test');
  git(repo, 'config', 'user.name', 'Acme Dev');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'billing-demo + ticket CANCEL-1 with proposed scenarios');
  return repo;
}

export function commitAll(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** Create a PR branch from main with the overlay's files applied (as an agent would). */
export function createPrBranch(repo, pr) {
  git(repo, 'checkout', '-q', '-b', pr.branch, 'main');
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== 'PR.md') files.push(relative(pr.overlay, p));
    }
  };
  walk(pr.overlay);
  for (const f of files) cpSync(join(pr.overlay, f), join(repo, f));
  const sha = commitAll(repo, pr.title);
  git(repo, 'checkout', '-q', 'main');
  return { sha, files };
}
