#!/usr/bin/env node
// Regenerates docs/reference/cli.md from the plugin registry (requires `pnpm build`).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCliHost, renderReference } from '@sluice-dev/cli';

const io = { cwd: process.cwd(), env: {}, stdout: { write() {} }, stderr: { write() {} } };
const cli = await createCliHost(io);
writeFileSync(join(import.meta.dirname, '..', 'docs', 'reference', 'cli.md'), renderReference(cli.host));
console.log('wrote docs/reference/cli.md');
