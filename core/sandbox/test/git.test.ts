import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutRef } from '@sluice-dev/sandbox';

describe('checkoutRef', () => {
  it('materialises a ref as a temporary worktree and removes it', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'sluice-git-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(join(repo, 'f.txt'), 'one');
    g('add', '.');
    g('commit', '-qm', 'one');
    const first = g('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'f.txt'), 'two');
    g('commit', '-qam', 'two');
    const co = await checkoutRef(repo, first);
    expect(co.sha).toBe(first);
    expect(readFileSync(join(co.dir, 'f.txt'), 'utf8')).toBe('one');
    await co.remove();
    expect(existsSync(co.dir)).toBe(false);
    await expect(checkoutRef(repo, 'no-such-ref')).rejects.toThrow(/rev-parse/);
  });
});
