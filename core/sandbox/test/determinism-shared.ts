// Shared scenario for the go / dotnet determinism shim integration tests: a
// fixture service exposing /now, /rand, /uuid, /emit and /egress.
import { join } from 'node:path';
import { expect } from 'vitest';
import { parseConfig } from '@sluice-dev/config';
import type { Sandbox } from '@sluice-dev/sandbox';

export const DAY = 86_400_000;
export const FIXTURES = join(import.meta.dirname, 'fixtures');

export function fixtureSpec(mode: 'go' | 'dotnet', env: Record<string, string> = {}) {
  return parseConfig(`
name: ${mode}-clock
sandbox:
  services:
    app:
      build: .
      source: src
      env: ${JSON.stringify({ PORT: '8080', ...env })}
      ports: [8080]
      determinism: ${mode}
      ready: { http: { port: 8080, path: /health } }
  ingress: { service: app, port: 8080 }
`).sandbox!;
}

export async function get<T = Record<string, unknown>>(sb: Sandbox, path: string): Promise<T> {
  const res = await fetch(sb.ingressUrl + path, { signal: AbortSignal.timeout(30_000) });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

export async function control(sb: Sandbox, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${sb.hostPort('app', 9999)}${path}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function clockScenario(sb: Sandbox): Promise<void> {
  const start = Date.parse('2030-01-15T12:00:00.000Z');
  expect(sb.clock.now()).toBe(start);
  const a = await get(sb, '/now');
  expect(a).toMatchObject({ ms: start });
  expect(String(a.iso)).toMatch(/^2030-01-15T12:00:00(\.0+)?Z$/);
  // frozen: real time passes, the app's clock does not
  await new Promise((r) => setTimeout(r, 1100));
  expect((await get(sb, '/now')).ms).toBe(start);
  expect(await control(sb, '/state')).toMatchObject({ nowMs: start, seed: 1 });

  await sb.advance(35 * DAY);
  expect((await get(sb, '/now')).ms).toBe(start + 35 * DAY);
  const at = Date.parse('2031-06-01T08:30:00.250Z');
  await sb.setClock(at);
  const b = await get(sb, '/now');
  expect(b.ms).toBe(at);
  expect(String(b.iso)).toMatch(/^2031-06-01T08:30:00\.250*Z$/);
  expect(await control(sb, '/state')).toMatchObject({ nowMs: at });
}

export async function eventsScenario(sb: Sandbox): Promise<void> {
  const before = (await sb.events('app')).total;
  expect(await get(sb, '/emit?name=order.created')).toEqual({ emitted: 'order.created' });
  // present immediately after the response, in write order, non-event lines skipped
  const r = await sb.events('app', before);
  expect(r.total).toBe(before + 3);
  expect(r.events).toEqual([
    expect.objectContaining({ event: 'order.created', seq: 1 }),
    { event: 'order.created.second', seq: 2 },
    { event: 'order.created.third', seq: 3 },
  ]);
  expect(String((r.events[0] as { at: string }).at)).toMatch(/^\d{4}-\d\d-\d\dT/);
  await get(sb, '/emit?name=b');
  const r2 = await sb.events('app', before + 3);
  expect(r2.events.map((e) => (e as { event: string }).event)).toEqual(['b', 'b.second', 'b.third']);
  expect((await sb.events('app', 0)).events).toHaveLength(before + 6);

  // a line split across requests, with an /events read (flush) in the middle
  await get(sb, '/partial?part=1');
  expect((await sb.events('app')).total).toBe(before + 6);
  await get(sb, '/partial?part=2');
  expect((await sb.events('app', before + 6)).events).toEqual([{ event: 'split', seq: 9 }]);
  expect(await sb.logs('app')).toContain('{"event":"split","seq":9}\n');
  expect(await sb.logs('app')).not.toContain('sluice-flush');
}

export async function egressScenario(sb: Sandbox): Promise<void> {
  expect(await sb.networks('app')).toEqual([sb.internalNetwork]);
  expect(await get(sb, '/egress')).toEqual({ https: 'BLOCKED', tcp: 'BLOCKED' });
}
