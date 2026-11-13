// `determinism: go`: frozen, host-movable clock; seeded math/rand, math/rand/v2,
// crypto/rand (incl. github.com/google/uuid); synchronous event capture; no egress.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sandbox, docker } from '@sluice-dev/sandbox';
import { prepareGoShim } from '../src/determinism/go.js';
import { FIXTURES, clockScenario, egressScenario, eventsScenario, fixtureSpec, get } from './determinism-shared.js';

describe('go determinism shim (golang:1.27-alpine)', () => {
  let sb: Sandbox;
  beforeAll(async () => {
    sb = await Sandbox.up({ root: join(FIXTURES, 'go-clock'), spec: fixtureSpec('go'), name: 'go-clock' });
  });
  afterAll(async () => {
    await sb?.down();
  });

  it('freezes the clock at the sandbox clock and moves it on advance / setClock', async () => {
    await clockScenario(sb);
    // frozen values carry no monotonic reading: time.Since follows the simulated clock
    const start = Date.parse('2030-01-15T12:00:00.000Z');
    expect((await get(sb, '/now')).sinceBoot).toBe(Date.parse('2031-06-01T08:30:00.250Z') - start);
  });

  it('captures stdout events in order, before the response returns', async () => {
    await eventsScenario(sb);
  });

  it('seeds math/rand, math/rand/v2, crypto/rand and uuid: same seed → same values, new seed → new values', async () => {
    const sample = async () => [await get(sb, '/rand'), await get(sb, '/uuid'), await get(sb, '/rand')];
    await sb.reset();
    const a = await sample();
    await sb.reset();
    expect(await sample()).toEqual(a);
    await sb.reset({ seed: 2 });
    const b = await sample();
    for (const k of ['v1', 'v2', 'crypto', 'text']) expect(b[0]![k]).not.toEqual(a[0]![k]);
    expect(b[1]!.uuid).not.toEqual(a[1]!.uuid);
    await sb.reset({ seed: 1 });
    expect(await sample()).toEqual(a);
    expect(a[0]).not.toEqual(a[2]); // a stream, not a constant
    expect(String(a[1]!.uuid)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // uuid v7 embeds the frozen clock
    expect(String(a[1]!.v7).replace(/-/g, '').slice(0, 12)).toBe(sb.clock.now().toString(16).padStart(12, '0'));
  });

  it('has zero real egress', async () => {
    await egressScenario(sb);
  });

  it('gives every container a private build cache (code under test cannot poison later runs)', async () => {
    const gocache = (await sb.exec('app', ['go', 'env', 'GOCACHE'])).stdout.trim();
    expect(gocache).not.toBe('');
    // the overlaid stdlib is already in the cache the container started with
    expect((await sb.exec('app', ['sh', '-c', `ls ${gocache} | wc -l`])).stdout.trim()).not.toBe('0');
    await sb.exec('app', ['sh', '-c', `echo poisoned > ${gocache}/README && touch ${gocache}/sluice-poison`]);
    await sb.reset();
    expect((await sb.exec('app', ['sh', '-c', `ls ${gocache}/sluice-poison 2>&1 || true`])).stdout).toMatch(
      /No such file/,
    );
    const mounts = await docker(['inspect', '-f', '{{json .Mounts}}', `sluice-${sb.id}-app`]);
    expect(mounts.stdout).not.toContain(gocache);
  });
});

describe('go determinism shim: oldest supported toolchain (golang:1.22-alpine)', () => {
  it('patches and links the 1.22 stdlib', async () => {
    const image = 'golang:1.22-alpine';
    if ((await docker(['image', 'inspect', image], { allowFail: true })).code !== 0)
      await docker(['pull', '-q', image], { timeoutMs: 600_000 });
    const shim = await prepareGoShim(image);
    expect(shim.version).toMatch(/^go1\.22/);
    const dir = mkdtempSync(join(tmpdir(), 'sluice-go122-'));
    writeFileSync(join(dir, 'go.mod'), 'module x\n\ngo 1.22\n');
    writeFileSync(
      join(dir, 'main.go'),
      [
        'package main',
        'import (',
        '\t"crypto/rand"',
        '\t"encoding/hex"',
        '\t"fmt"',
        '\tmrand "math/rand"',
        '\trand2 "math/rand/v2"',
        '\t_ "net/http"',
        '\t"time"',
        ')',
        'func main() {',
        '\tb := make([]byte, 4)',
        '\t_, _ = rand.Read(b)',
        '\tfmt.Println(time.Now().UnixMilli(), mrand.Int63(), rand2.Uint64(), hex.EncodeToString(b))',
        '}',
      ].join('\n'),
    );
    const run = (seed: number) =>
      docker(
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${shim.dir}:/sluice/go:ro`,
          '-v',
          `${dir}:/w:ro`,
          '-w',
          '/w',
          '-e',
          'GOFLAGS=-overlay=/sluice/go/overlay.json',
          '-e',
          'GOTOOLCHAIN=local',
          '-e',
          'SLUICE_NOW_MS=1894708800123',
          '-e',
          `SLUICE_SEED=${seed}`,
          image,
          'go',
          'run',
          '.',
        ],
        { timeoutMs: 300_000 },
      );
    const one = (await run(1)).stdout.trim().split(' ');
    expect(one[0]).toBe('1894708800123');
    expect((await run(1)).stdout.trim().split(' ')).toEqual(one);
    expect((await run(2)).stdout.trim().split(' ').slice(1)).not.toEqual(one.slice(1));
  });
});
