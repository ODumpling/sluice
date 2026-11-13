import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { checkoutRef, git } from '@sluice-dev/sandbox';

export interface Build {
  label: string;
  sourceRoot: string;
  cleanup(): Promise<void>;
}

/**
 * A build is a source tree for the project at `root`: the working tree
 * (default), another directory (--source) or a git ref (--ref, checked out as
 * a temporary worktree).
 */
export async function resolveBuild(root: string, opts: { source?: unknown; ref?: unknown }): Promise<Build> {
  if (typeof opts.source === 'string') {
    return { label: opts.source, sourceRoot: resolve(opts.source), cleanup: async () => {} };
  }
  if (typeof opts.ref === 'string') {
    const top = (await git(['rev-parse', '--show-toplevel'], root)).trim();
    const co = await checkoutRef(root, opts.ref);
    return {
      label: `${opts.ref}@${co.sha.slice(0, 8)}`,
      sourceRoot: resolve(co.dir, relative(top, realpathSync(root))),
      cleanup: () => co.remove(),
    };
  }
  return { label: 'working tree', sourceRoot: root, cleanup: async () => {} };
}
