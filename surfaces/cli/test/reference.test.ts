import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCliHost, renderReference } from '@sluice-dev/cli';

describe('docs/reference/cli.md', () => {
  it('is up to date with the registered commands and tools (run `pnpm docs:gen`)', async () => {
    const cli = await createCliHost({ cwd: tmpdir(), env: {}, stdout: { write() {} }, stderr: { write() {} } });
    const file = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'reference', 'cli.md'), 'utf8');
    expect(file).toBe(renderReference(cli.host));
  });
});
