/**
 * Docker sandbox driven by a sluice.yaml `sandbox:` spec.
 *
 * Topology (see ADR-0002):
 *
 *   host (Sluice process)                 docker
 *   ─────────────────────                 ───────────────────────────────────────────
 *   fakes (stripe, …) on host ports  <──  gateway ──┬── internal network (no route out)
 *   ingress / db / control clients   ──>  (only     │     app, db, … services
 *                                          bridge)  │
 *
 * Services run only on an `--internal` network, so the app has no route to the
 * internet. A small gateway container is attached to both the internal network
 * and a regular bridge; it forwards exactly: host→service ports (published on
 * 127.0.0.1), and service→fake (to Sluice-hosted fakes via host.docker.internal).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { SandboxSpec, ServiceSpec } from '@sluice-dev/config';
import { FakeServer, GitHubFake, SimClock, StripeFake, type Fake } from '@sluice-dev/fakes';
import { docker, dockerStream } from './docker.js';

export const GATEWAY_IMAGE = 'node:22-alpine';
export const CONTROL_PORT = 9999;
const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));

export type FakeFactory = (clock: SimClock, seed: number) => Fake;

/** Built-in fakes by name. Plugins/hosts can pass more via SandboxOptions.fakeFactories. */
export const DEFAULT_FAKES: Record<string, FakeFactory> = {
  stripe: (clock, seed) => new StripeFake({ clock, seed }),
  github: (clock) => new GitHubFake({ clock }),
};

export interface SandboxOptions {
  /** Directory containing sluice.yaml (build contexts resolve against it). */
  root: string;
  spec: SandboxSpec;
  name?: string;
  /** Directory whose `source` dirs are mounted into services (default: root). Swap to test another build. */
  sourceRoot?: string;
  seed?: number;
  startMs?: number;
  log?: (msg: string) => void;
  /** Called once against the empty application database before it is snapshotted as the reset template. */
  prepareDatabase?: (client: pg.Client) => Promise<void>;
  fakeFactories?: Record<string, FakeFactory>;
  /** Where host-side fakes listen. Default: 127.0.0.1 on macOS/Windows, 0.0.0.0 on Linux (docker bridge). */
  fakesBindHost?: string;
  readyTimeoutMs?: number;
}

interface Forward {
  listen: number;
  host: string;
  port: number;
  publish: boolean;
}

function topo(services: Record<string, ServiceSpec>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string, stack: string[]) => {
    if (seen.has(n)) return;
    if (stack.includes(n)) throw new Error(`dependency cycle: ${[...stack, n].join(' -> ')}`);
    for (const d of services[n]!.dependsOn) visit(d, [...stack, n]);
    seen.add(n);
    out.push(n);
  };
  for (const n of Object.keys(services).sort()) visit(n, []);
  return out;
}

const HASH_IGNORE = new Set(['node_modules', '.git', '.sluice', 'dist', 'coverage']);

function contextHash(dir: string, exclude: string | undefined): string {
  const h = createHash('sha256');
  const ignore = new Set(HASH_IGNORE);
  const di = join(dir, '.dockerignore');
  if (existsSync(di))
    for (const l of readFileSync(di, 'utf8').split('\n')) if (l.trim()) ignore.add(l.trim().replace(/\/$/, ''));
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (ignore.has(e.name) || ignore.has(rel) || (exclude && rel === exclude)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) h.update(rel).update('\0').update(readFileSync(p)).update('\0');
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

/** Thrown inside a waitFor probe to abort waiting immediately. */
class FatalError extends Error {}

async function waitFor(what: string, fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 100;
  for (;;) {
    const ok = await fn().catch((e: unknown) => {
      if (e instanceof FatalError) throw e;
      return false;
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 1000);
  }
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

export class Sandbox {
  readonly id: string;
  readonly name: string;
  readonly spec: SandboxSpec;
  readonly root: string;
  readonly clock: SimClock;
  readonly fakes = new Map<string, FakeServer>();
  private sourceRoot: string;
  private seed: number;
  private startMs: number;
  private readonly log: (msg: string) => void;
  private readonly opts: SandboxOptions;
  private readonly images = new Map<string, string>();
  private readonly hostPorts = new Map<string, number>();
  private readonly fakeAddr = new Map<string, number>();
  private started = false;

  private constructor(opts: SandboxOptions) {
    this.opts = opts;
    this.spec = opts.spec;
    this.root = resolve(opts.root);
    this.sourceRoot = resolve(opts.sourceRoot ?? opts.root);
    this.name = (opts.name ?? 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    this.id = `${randomBytes(4).toString('hex')}`;
    this.seed = opts.seed ?? opts.spec.seed;
    this.startMs = opts.startMs ?? Date.parse(opts.spec.clock);
    this.clock = new SimClock(this.startMs);
    this.log = opts.log ?? (() => {});
  }

  static async up(opts: SandboxOptions): Promise<Sandbox> {
    const sb = new Sandbox(opts);
    try {
      await sb.start();
    } catch (e) {
      await sb.down().catch(() => {});
      throw e;
    }
    return sb;
  }

  // ------------------------------------------------------------ naming

  private container(svc: string): string {
    return `sluice-${this.id}-${svc}`;
  }
  private get gateway(): string {
    return `sluice-${this.id}-gw`;
  }
  private get internalNet(): string {
    return `sluice-${this.id}-int`;
  }
  private get externalNet(): string {
    return `sluice-${this.id}-ext`;
  }
  private labels(): string[] {
    return ['--label', `sluice.sandbox=${this.id}`, '--label', `sluice.project=${this.name}`];
  }

  // ------------------------------------------------------------ public API

  /** Host URL for the ingress service. */
  get ingressUrl(): string {
    return `http://127.0.0.1:${this.hostPort(this.spec.ingress.service, this.spec.ingress.port)}`;
  }

  /** Host-side connection string for the application database. */
  get databaseUrl(): string {
    const d = this.spec.database;
    if (!d) throw new Error('sandbox spec has no database');
    return `postgres://${encodeURIComponent(d.user)}:${encodeURIComponent(d.password)}@127.0.0.1:${this.hostPort(d.service, d.port)}/${d.name}`;
  }

  hostPort(service: string, port: number): number {
    const p = this.hostPorts.get(`${service}:${port}`);
    if (p === undefined) throw new Error(`port ${service}:${port} is not forwarded (declare it under ports:)`);
    return p;
  }

  get currentSourceRoot(): string {
    return this.sourceRoot;
  }

  /** Move simulated time for fakes and every determinism-enabled service. */
  async setClock(ms: number): Promise<void> {
    this.clock.set(ms);
    await this.pushClock();
  }

  async advance(ms: number): Promise<void> {
    await this.setClock(this.clock.now() + ms);
  }

  /**
   * Return the sandbox to a pristine state: app containers recreated (fresh
   * process, re-seeded shim), database restored from the post-prepare
   * template, fakes and clock reset. Optionally switch to another source tree.
   */
  async reset(opts: { seed?: number; startMs?: number; sourceRoot?: string } = {}): Promise<void> {
    if (opts.seed !== undefined) this.seed = opts.seed;
    if (opts.startMs !== undefined) this.startMs = opts.startMs;
    if (opts.sourceRoot !== undefined) this.sourceRoot = resolve(opts.sourceRoot);
    const order = topo(this.spec.services);
    const stateless = order.filter((s) => s !== this.spec.database?.service);
    await Promise.all(stateless.map((s) => docker(['rm', '-f', this.container(s)], { allowFail: true })));
    if (this.spec.database) await this.restoreDatabase();
    this.clock.reset(this.startMs);
    for (const f of this.fakes.values()) f.reset(this.seed);
    for (const s of stateless) await this.runService(s);
    for (const s of stateless) await this.waitReady(s);
  }

  async logs(service: string): Promise<string> {
    const r = await docker(['logs', this.container(service)], { allowFail: true });
    return r.stdout;
  }

  async exec(service: string, cmd: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return docker(['exec', this.container(service), ...cmd], { allowFail: true });
  }

  /**
   * Run a one-off command in a service's image with no network at all (e.g. a
   * PR's unit tests). Host directories are mounted read-only.
   */
  async runOneOff(
    service: string,
    command: string[],
    mounts: { host: string; container: string }[] = [],
    timeoutMs = 300_000,
  ): Promise<{ code: number; output: string }> {
    const svc = this.spec.services[service];
    if (!svc) throw new Error(`no service ${service}`);
    const args = ['run', '--rm', ...this.labels(), '--network', 'none', '-w', svc.workdir];
    for (const m of mounts) args.push('-v', `${m.host}:${m.container}:ro`);
    args.push(this.images.get(service)!, ...command);
    const r = await docker(args, { allowFail: true, timeoutMs });
    return { code: r.code, output: r.stdout + r.stderr };
  }

  /** Docker networks a service container is attached to. */
  async networks(service: string): Promise<string[]> {
    const r = await docker(['inspect', '-f', '{{json .NetworkSettings.Networks}}', this.container(service)]);
    return Object.keys(JSON.parse(r.stdout) as Record<string, unknown>).sort();
  }

  /** Domain events captured by the determinism shim of a service (JSON stdout lines with an "event" key). */
  async events(service: string, since = 0): Promise<{ total: number; events: unknown[] }> {
    const port = this.hostPort(service, CONTROL_PORT);
    const res = await fetch(`http://127.0.0.1:${port}/events?since=${since}`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`events from ${service}: HTTP ${res.status}`);
    return (await res.json()) as { total: number; events: unknown[] };
  }

  /** Services running the Node determinism shim. */
  get deterministicServices(): string[] {
    return Object.entries(this.spec.services)
      .filter(([, s]) => s.determinism === 'node')
      .map(([n]) => n);
  }

  get internalNetwork(): string {
    return this.internalNet;
  }

  async down(): Promise<void> {
    const r = await docker(['ps', '-aq', '--filter', `label=sluice.sandbox=${this.id}`], { allowFail: true });
    const ids = r.stdout.split('\n').filter(Boolean);
    if (ids.length) await docker(['rm', '-f', ...ids], { allowFail: true });
    await docker(['network', 'rm', this.internalNet, this.externalNet], { allowFail: true });
    for (const f of this.fakes.values()) await f.stop();
    this.fakes.clear();
    this.started = false;
  }

  /** Remove every sandbox container/network left behind by crashed runs. */
  static async pruneAll(): Promise<number> {
    const r = await docker(['ps', '-aq', '--filter', 'label=sluice.sandbox'], { allowFail: true });
    const ids = r.stdout.split('\n').filter(Boolean);
    if (ids.length) await docker(['rm', '-f', ...ids], { allowFail: true });
    const n = await docker(['network', 'ls', '-q', '--filter', 'name=sluice-'], { allowFail: true });
    const nets = n.stdout.split('\n').filter(Boolean);
    if (nets.length) await docker(['network', 'rm', ...nets], { allowFail: true });
    return ids.length;
  }

  // ------------------------------------------------------------ startup

  private async start(): Promise<void> {
    const services = this.spec.services;
    const order = topo(services);

    // 1. images
    for (const s of order) await this.ensureImage(s, services[s]!);
    await this.ensurePulled(GATEWAY_IMAGE);

    // 2. fakes on the host
    const factories = { ...DEFAULT_FAKES, ...this.opts.fakeFactories };
    const bind =
      this.opts.fakesBindHost ??
      process.env.SLUICE_FAKES_BIND ??
      (process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1');
    for (const name of this.spec.fakes) {
      const factory = factories[name];
      if (!factory) throw new Error(`no fake named ${name}`);
      const server = new FakeServer(factory(this.clock, this.seed), { clock: this.clock, host: bind });
      await server.start();
      this.fakes.set(name, server);
    }

    // 3. networks + gateway
    await docker(['network', 'create', '--internal', ...this.labels(), this.internalNet]);
    await docker(['network', 'create', ...this.labels(), this.externalNet]);
    const forwards: Forward[] = [];
    let next = 20000;
    const inbound = new Map<string, number>();
    for (const s of order) {
      const svc = services[s]!;
      const ports = [...svc.ports, ...(svc.determinism === 'node' ? [CONTROL_PORT] : [])];
      for (const p of ports) {
        const listen = next++;
        forwards.push({ listen, host: s, port: p, publish: true });
        inbound.set(`${s}:${p}`, listen);
      }
    }
    for (const [name, server] of this.fakes) {
      const listen = next++;
      forwards.push({ listen, host: 'host.docker.internal', port: server.port, publish: false });
      this.fakeAddr.set(name, listen);
    }
    const publish = forwards.filter((f) => f.publish).flatMap((f) => ['-p', `127.0.0.1::${f.listen}`]);
    await docker([
      'run',
      '-d',
      '--name',
      this.gateway,
      ...this.labels(),
      '--network',
      this.externalNet,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-v',
      `${join(ASSETS, 'gateway.cjs')}:/sluice/gateway.cjs:ro`,
      '-e',
      `FORWARDS=${forwards.map((f) => `${f.listen}=${f.host}:${f.port}`).join(',')}`,
      ...publish,
      GATEWAY_IMAGE,
      'node',
      '/sluice/gateway.cjs',
    ]);
    await docker(['network', 'connect', '--alias', 'sluice-gw', this.internalNet, this.gateway]);
    for (const [key, listen] of inbound) {
      const r = await docker(['port', this.gateway, `${listen}/tcp`]);
      const m = /:(\d+)\s*$/m.exec(r.stdout.split('\n')[0] ?? '');
      if (!m) throw new Error(`could not resolve published port for ${key}: ${r.stdout}`);
      this.hostPorts.set(key, Number(m[1]));
    }

    // 4. services in dependency order; database is prepared + snapshotted before dependants start
    const dbName = this.spec.database?.service;
    for (const s of order) {
      await this.runService(s);
      await this.waitReady(s);
      if (s === dbName) await this.snapshotDatabase();
    }
    this.started = true;
    this.log(`sandbox ${this.id} up: ingress ${this.ingressUrl}`);
  }

  private async ensurePulled(image: string): Promise<void> {
    const r = await docker(['image', 'inspect', image], { allowFail: true });
    if (r.code !== 0) {
      this.log(`pulling ${image}`);
      await dockerStream(['pull', '-q', image]);
    }
  }

  private async ensureImage(name: string, svc: ServiceSpec): Promise<void> {
    if (svc.image) {
      await this.ensurePulled(svc.image);
      this.images.set(name, svc.image);
      return;
    }
    const ctx = resolve(this.root, svc.build!);
    const tag = `sluice-${this.name}-${name}:${contextHash(ctx, svc.source)}`;
    const exists = await docker(['image', 'inspect', tag], { allowFail: true });
    if (exists.code !== 0) {
      this.log(`building ${tag}`);
      const args = ['build', '-q', '-t', tag, '--label', 'sluice.image=1'];
      if (svc.dockerfile) args.push('-f', resolve(ctx, svc.dockerfile));
      await dockerStream([...args, ctx]);
    }
    this.images.set(name, tag);
  }

  private interpolate(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
      const m = /^fakes\.([a-z0-9-]+)\.url$/.exec(expr.trim());
      if (m) {
        const port = this.fakeAddr.get(m[1]!);
        if (port === undefined) throw new Error(`${whole}: fake ${m[1]} is not enabled in sandbox.fakes`);
        return `http://sluice-gw:${port}`;
      }
      if (expr.trim() === 'sandbox.id') return this.id;
      throw new Error(`unknown interpolation ${whole}`);
    });
  }

  private async runService(name: string): Promise<void> {
    const svc = this.spec.services[name]!;
    const args = [
      'run',
      '-d',
      '--name',
      this.container(name),
      ...this.labels(),
      '--network',
      this.internalNet,
      '--network-alias',
      name,
      '-w',
      svc.workdir,
      // caps keep a runaway build (e.g. an infinite-loop mutant) from starving the Docker host
      '--cpus',
      '2',
      '--memory',
      '2g',
      '--pids-limit',
      '1024',
    ];
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(svc.env)) env[k] = this.interpolate(v);
    if (svc.determinism === 'node') {
      args.push('-v', `${join(ASSETS, 'determinism.cjs')}:/sluice/determinism.cjs:ro`);
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}--require /sluice/determinism.cjs`;
      env.SLUICE_SEED = String(this.seed);
      env.SLUICE_NOW_MS = String(this.clock.now());
      env.SLUICE_CONTROL_PORT = String(CONTROL_PORT);
    }
    if (svc.source) {
      const ctx = svc.build ? relative(this.root, resolve(this.root, svc.build)) : '.';
      const src = resolve(this.sourceRoot, ctx, svc.source);
      if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`source dir ${src} does not exist`);
      args.push('-v', `${src}:${svc.workdir.replace(/\/$/, '')}/${svc.source}:ro`);
    }
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push(this.images.get(name)!, ...(svc.command ?? []));
    await docker(args);
  }

  private async waitReady(name: string): Promise<void> {
    const svc = this.spec.services[name]!;
    const timeout = this.opts.readyTimeoutMs ?? 90_000;
    const running = async () => {
      const r = await docker(['inspect', '-f', '{{.State.Running}}', this.container(name)], { allowFail: true });
      if (r.stdout.trim() !== 'true') {
        const out = await docker(['logs', '--tail', '40', this.container(name)], { allowFail: true });
        throw new FatalError(`service ${name} exited during startup:\n${out.stdout}${out.stderr}`);
      }
    };
    const ready = svc.ready;
    if (!ready) {
      await running();
    } else if ('exec' in ready) {
      await waitFor(`${name} (exec)`, async () => (await this.exec(name, ready.exec)).code === 0, timeout);
    } else if ('http' in ready) {
      const port = this.hostPort(name, ready.http.port);
      await waitFor(
        `${name} (http ${ready.http.path})`,
        async () => {
          await running();
          const res = await fetch(`http://127.0.0.1:${port}${ready.http.path}`, { signal: AbortSignal.timeout(5_000) });
          await res.arrayBuffer();
          return res.ok;
        },
        timeout,
      );
    } else {
      const port = this.hostPort(name, ready.tcp);
      await waitFor(`${name} (tcp ${ready.tcp})`, async () => (await running(), await tcpOpen(port)), timeout);
    }
    if (svc.determinism === 'node') {
      const port = this.hostPort(name, CONTROL_PORT);
      await waitFor(
        `${name} determinism control`,
        async () => (await fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(5_000) })).ok,
        timeout,
      );
    }
  }

  private async pushClock(): Promise<void> {
    for (const [name, svc] of Object.entries(this.spec.services)) {
      if (svc.determinism !== 'node') continue;
      const port = this.hostPort(name, CONTROL_PORT);
      const res = await fetch(`http://127.0.0.1:${port}/clock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nowMs: this.clock.now() }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`clock push to ${name} failed: ${res.status}`);
      await res.arrayBuffer();
    }
  }

  // ------------------------------------------------------------ database

  private adminUrl(db: string): string {
    const d = this.spec.database!;
    return `postgres://${encodeURIComponent(d.user)}:${encodeURIComponent(d.password)}@127.0.0.1:${this.hostPort(d.service, d.port)}/${db}`;
  }

  private async withClient<T>(db: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({
      connectionString: this.adminUrl(db),
      connectionTimeoutMillis: 10_000,
      query_timeout: 60_000,
    });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  private get templateName(): string {
    return `${this.spec.database!.name}_sluice_template`;
  }

  private async snapshotDatabase(): Promise<void> {
    const d = this.spec.database!;
    // The image's init may briefly restart the server; wait until TCP queries work.
    await waitFor(
      'database accepts TCP connections',
      () => this.withClient(d.name, async (c) => (await c.query('SELECT 1'), true)),
      60_000,
    );
    if (this.opts.prepareDatabase) await this.withClient(d.name, this.opts.prepareDatabase);
    await this.withClient('postgres', async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${this.templateName}"`);
      await c.query(`CREATE DATABASE "${this.templateName}" TEMPLATE "${d.name}"`);
    });
  }

  private async restoreDatabase(): Promise<void> {
    const d = this.spec.database!;
    await this.withClient('postgres', async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${d.name}" WITH (FORCE)`);
      await c.query(`CREATE DATABASE "${d.name}" TEMPLATE "${this.templateName}"`);
    });
  }

  get isUp(): boolean {
    return this.started;
  }
}
