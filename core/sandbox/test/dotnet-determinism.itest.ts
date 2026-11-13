// `determinism: dotnet`: frozen, host-movable clock; seeded Guid.NewGuid,
// RandomNumberGenerator and string hashing; synchronous event capture via
// sluice-init's stdout pipe; no egress.
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sandbox } from '@sluice-dev/sandbox';
import { FIXTURES, clockScenario, egressScenario, eventsScenario, fixtureSpec, get } from './determinism-shared.js';

describe('dotnet determinism shim (mcr.microsoft.com/dotnet/sdk:10.0)', () => {
  let sb: Sandbox;
  beforeAll(async () => {
    sb = await Sandbox.up({ root: join(FIXTURES, 'dotnet-clock'), spec: fixtureSpec('dotnet'), name: 'dotnet-clock' });
  });
  afterAll(async () => {
    await sb?.down();
  });

  it('freezes the clock at the sandbox clock and moves it on advance / setClock', async () => {
    await clockScenario(sb);
    const now = await get(sb, '/now');
    expect(now.local).toBe(now.iso); // DateTime.Now is the same instant
    expect(now.uptimeTicking).toBe(true); // Stopwatch (CLOCK_MONOTONIC) stays real
  });

  it('captures stdout events in order, before the response returns', async () => {
    await eventsScenario(sb);
  });

  it('seeds Guid, RandomNumberGenerator, Random.Shared and new Random(): same seed → same values, new seed → new values', async () => {
    const sample = async () => [await get(sb, '/rand'), await get(sb, '/uuid'), await get(sb, '/rand')];
    await sb.reset();
    const a = await sample();
    await sb.reset();
    expect(await sample()).toEqual(a);
    await sb.reset({ seed: 2 });
    const b = await sample();
    for (const k of ['rng', 'shared', 'unseeded', 'fresh']) expect(b[0]![k]).not.toEqual(a[0]![k]);
    expect(b[1]!.uuid).not.toEqual(a[1]!.uuid);
    expect(b[1]!.v7).not.toEqual(a[1]!.v7);
    await sb.reset({ seed: 1 });
    expect(await sample()).toEqual(a);
    expect(a[0]).not.toEqual(a[2]);
    expect(String(a[1]!.uuid)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(String(a[1]!.v7).replace(/-/g, '').slice(0, 12)).toBe(sb.clock.now().toString(16).padStart(12, '0'));
  });

  it('Random.Shared / new Random() are identical across 10 resets (single thread-pool worker)', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      await sb.reset();
      const r = [await get(sb, '/rand'), await get(sb, '/uuid'), await get(sb, '/rand'), await get(sb, '/rand')];
      seen.add(JSON.stringify(r));
    }
    expect(seen.size).toBe(1);
  });

  it('has zero real egress', async () => {
    await egressScenario(sb);
  });

  it('builds with the SDK on real time and runs only the app under the shim', async () => {
    // exec'd processes are outside sluice-init's LD_PRELOAD: real wall clock
    const r = await sb.exec('app', ['date', '+%Y']);
    expect(Number(r.stdout.trim())).toBeLessThan(2030);
    const ps = await sb.exec('app', [
      'sh',
      '-c',
      'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline; echo; grep -l libsluice $p/maps >/dev/null 2>&1 && echo "  ^ shim"; done',
    ]);
    expect(ps.stdout).toContain('/sluice/dotnet/sluice-init');
  });
});
