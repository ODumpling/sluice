// Prepared (dependency-fetched) images: only manifests are copied in, the cache
// key follows the resolved base image ID, and tests run offline in the result.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { docker, prepareImage, runInContainer, type PrepareSpec } from '@sluice-dev/sandbox';

const BASE = `sluice-test-prepare-base:${process.pid}`;
const made = new Set<string>();

async function buildBase(marker: string): Promise<void> {
  await docker(['build', '-q', '-t', BASE, '-f', '-', mkdtempSync(join(tmpdir(), 'sluice-prep-ctx-'))], {
    input: `FROM alpine:3\nRUN echo ${marker} > /base-marker\n`,
    timeoutMs: 600_000,
  });
}

describe('prepareImage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sluice-prep-tree-'));
  mkdirSync(join(dir, 'svc'));
  writeFileSync(join(dir, 'svc', 'deps.lock'), 'left-pad 1.0.0\n');
  writeFileSync(join(dir, 'svc', 'main.src'), 'source\n');
  const spec: PrepareSpec = {
    // records what the build saw: the base marker, and that only manifests were copied in
    command: 'cat /base-marker > /prepared && cat svc/deps.lock >> /prepared && test ! -e svc/main.src',
    manifest: (f) => f.endsWith('.lock'),
    env: { PREP_ENV: 'baked' },
  };
  afterAll(async () => {
    await docker(['rmi', '-f', BASE, ...made], { allowFail: true });
  });

  it('reuses the image for the same base and manifests, and rebuilds when the base tag moves', async () => {
    await buildBase('first');
    const a = await prepareImage(dir, BASE, spec);
    made.add(a);
    expect(await prepareImage(dir, BASE, spec)).toBe(a);

    const r = await runInContainer(dir, 'cat /prepared && echo $PREP_ENV && cat svc/main.src', a, 120);
    expect(r.passed, r.outputTail).toBe(true);
    expect(r.outputTail).toContain('first\nleft-pad 1.0.0\nbaked\nsource');

    // same tag, new image (e.g. a re-pulled newer base), identical manifests -> new prepared image
    await buildBase('second');
    const b = await prepareImage(dir, BASE, spec);
    made.add(b);
    expect(b).not.toBe(a);
    const r2 = await runInContainer(dir, 'cat /prepared', BASE, 120, { prepare: spec });
    expect(r2.outputTail).toContain('second');

    // a manifest change also rebuilds
    writeFileSync(join(dir, 'svc', 'deps.lock'), 'left-pad 1.0.1\n');
    const c = await prepareImage(dir, BASE, spec);
    made.add(c);
    expect(c).not.toBe(b);
  });

  it('reports a failing prepare without running the tests', async () => {
    const r = await runInContainer(dir, 'echo never', 'alpine:3', 60, {
      prepare: { command: 'echo boom >&2; exit 3', manifest: () => false },
    });
    expect(r).toMatchObject({ passed: false, exitCode: 125, prepareFailed: true });
    expect(r.outputTail).toContain('boom');
  });
});
