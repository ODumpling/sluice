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

  it('seeds Guid.NewGuid / CreateVersion7 and RandomNumberGenerator: same seed → same values, new seed → new values', async () => {
    // Random.Shared / new Random() are seeded too but depend on which thread-pool
    // thread serves the request (Random.Shared is thread-local): best effort, not asserted.
    const pick = (r: Record<string, unknown>) => ({ rng: r.rng, rngInt: r.rngInt });
    const sample = async () =>
      [pick(await get(sb, '/rand')), await get(sb, '/uuid'), pick(await get(sb, '/rand'))] as Record<string, unknown>[];
    await sb.reset();
    const a = await sample();
    await sb.reset();
    expect(await sample()).toEqual(a);
    await sb.reset({ seed: 2 });
    const b = await sample();
    expect(b[0]!.rng).not.toEqual(a[0]!.rng);
    expect(b[1]!.uuid).not.toEqual(a[1]!.uuid);
    expect(b[1]!.v7).not.toEqual(a[1]!.v7);
    await sb.reset({ seed: 1 });
    expect(await sample()).toEqual(a);
    expect(a[0]).not.toEqual(a[2]);
    expect(String(a[1]!.uuid)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(String(a[1]!.v7).replace(/-/g, '').slice(0, 12)).toBe(sb.clock.now().toString(16).padStart(12, '0'));
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
