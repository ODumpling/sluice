/**
 * `determinism: go` — a `go build -overlay` that patches the standard library
 * of the service image's own Go toolchain (see ADR-0010).
 *
 * Go reads the wall clock through the vDSO and randomness through getrandom(2)
 * without libc, so LD_PRELOAD cannot intercept it. Instead every service
 * compiles from mounted source at container start (`go run ./cmd/server`,
 * `go build … && ./server`) with `GOFLAGS=-overlay=/sluice/go/overlay.json`:
 *
 * - time:          `Now` returns the frozen sandbox clock (moved over HTTP);
 * - math/rand(/v2): the unseeded top-level source is seeded from SLUICE_SEED;
 * - crypto/rand:   `Reader` is a seeded stream (before any importer's init);
 * - os:            writes to fd 1 are tapped synchronously for domain events;
 * - net/http:      init() starts the control server on SLUICE_CONTROL_PORT.
 *
 * The overlay is generated on the host from the image's GOROOT sources and
 * cached per image id.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { docker } from '../docker.js';
import { ASSETS, DeterminismError, cacheRoot, imageId } from './common.js';

/** Container path where the generated overlay directory is mounted. */
export const GO_MOUNT = '/sluice/go';
export const GO_MIN_VERSION: readonly [number, number] = [1, 22];

/** GOROOT/src files the overlay replaces with patched copies. */
export const GO_PATCHED_FILES = ['time/time.go', 'os/file.go', 'math/rand/rand.go', 'math/rand/v2/rand.go'] as const;

/** Shim sources (assets/go/<asset>) added to std packages as zz_sluice.go. */
const GO_ADDED: { pkg: string; asset: string; suffix?: string }[] = [
  { pkg: 'time', asset: 'time.go' },
  { pkg: 'os', asset: 'os.go' },
  { pkg: 'math/rand', asset: 'mathrand.go', suffix: '\nconst sluiceStreamLabel = 0x6d61746872616e64\n' },
  { pkg: 'math/rand/v2', asset: 'mathrand.go', suffix: '\nconst sluiceStreamLabel = 0x72616e647632\n' },
  { pkg: 'crypto/rand', asset: 'cryptorand.go' },
  { pkg: 'net/http', asset: 'http.go' },
];

const FILE_MARK = '@@sluice-file:';
/** Bump when patch rules change (part of the overlay cache key). */
const GO_SHIM_REVISION = 'go-shim-2';

/** Shell script run in the service image (no network) to read the toolchain. */
export const GO_PROBE_SCRIPT = [
  'set -e',
  'command -v go >/dev/null || { echo "@@sluice-error:no go command on PATH" ; exit 0; }',
  'echo "@@sluice-goroot:$(go env GOROOT)"',
  'echo "@@sluice-goversion:$(go env GOVERSION)"',
  'echo "@@sluice-gocache:$(go env GOCACHE)"',
  'echo "@@sluice-goflags:$(go env GOFLAGS)"',
  'R="$(go env GOROOT)/src"',
  `for f in ${GO_PATCHED_FILES.join(' ')}; do echo "${FILE_MARK}$f"; if [ -f "$R/$f" ]; then cat "$R/$f"; echo; fi; done`,
].join('\n');

export interface GoProbe {
  goroot: string;
  version: string;
  gocache: string;
  /** The image's effective GOFLAGS (ENV / go env -w), kept in front of the overlay flag. */
  goflags: string;
  /** GOROOT/src-relative path → contents (absent if the file does not exist). */
  files: Record<string, string>;
}

export function parseGoProbe(stdout: string): GoProbe {
  const err = /^@@sluice-error:(.*)$/m.exec(stdout);
  if (err) throw new DeterminismError(`determinism: go: ${err[1]} in the service image`);
  const field = (k: string) => new RegExp(`^@@sluice-${k}:(.*)$`, 'm').exec(stdout)?.[1]?.trim() ?? '';
  const probe: GoProbe = {
    goroot: field('goroot'),
    version: field('goversion'),
    gocache: field('gocache'),
    goflags: field('goflags'),
    files: {},
  };
  if (!probe.goroot || !probe.version)
    throw new DeterminismError(`determinism: go: could not read GOROOT/GOVERSION from the service image`);
  const parts = stdout.split(new RegExp(`^${FILE_MARK}(.+)$`, 'm'));
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const body = parts[i + 1]!.replace(/^\n/, '').replace(/\n$/, '');
    if (body.trim()) probe.files[parts[i]!.trim()] = body;
  }
  return probe;
}

/** `go1.27.4` / `go1.22rc1` / `devel go1.28-abc` → [1, 27]. */
export function parseGoVersion(v: string): [number, number] | undefined {
  const m = /go(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

function patchOnce(file: string, src: string, version: string, what: string, re: RegExp, to: string): string {
  const hits = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  if (hits?.length !== 1) {
    throw new DeterminismError(
      `determinism: go: cannot patch GOROOT/src/${file} of ${version}: ${what} ` +
        `${hits ? `found ${hits.length} times` : 'not found'}. Supported toolchains: go${GO_MIN_VERSION.join('.')} and newer ` +
        `whose ${file} still declares it; use determinism: none or report this Go version.`,
    );
  }
  return src.replace(re, to);
}

/** Apply the shim's source patches to one GOROOT file (pure; exported for tests). */
export function patchGoFile(file: string, src: string, version: string): string {
  if (src.includes('sluice')) throw new DeterminismError(`determinism: go: GOROOT/src/${file} is already patched`);
  switch (file) {
    case 'time/time.go':
      return patchOnce(
        file,
        src,
        version,
        '`func Now() Time {`',
        /^func Now\(\) Time \{$/m,
        'func sluiceRealNow() Time {',
      );
    case 'os/file.go':
      return patchOnce(
        file,
        src,
        version,
        '`func (f *File) Write(b []byte) (n int, err error) {`',
        /^func \(f \*File\) Write\(b \[\]byte\) \(n int, err error\) \{$/m,
        'func (f *File) Write(b []byte) (n int, err error) {\n' +
          '\tif SluiceStdoutTap != nil && f != nil && f.file != nil && f.pfd.Sysfd == 1 {\n' +
          '\t\tSluiceStdoutTap(b)\n' +
          '\t}',
      );
    case 'math/rand/rand.go':
    case 'math/rand/v2/rand.go':
      return patchOnce(
        file,
        src,
        version,
        '`//go:linkname runtime_rand runtime.rand` + `func runtime_rand() uint64`',
        /^\/\/go:linkname runtime_rand runtime\.rand\nfunc runtime_rand\(\) uint64$/m,
        '//go:linkname sluiceRuntimeRand runtime.rand\nfunc sluiceRuntimeRand() uint64',
      );
    default:
      throw new Error(`no go patch for ${file}`);
  }
}

export interface GoOverlay {
  /** Overlay-dir-relative path → contents (includes overlay.json). */
  files: Record<string, string>;
}

/**
 * Build the overlay for a probed toolchain. `mount` is where the overlay dir
 * is mounted in the container; `assets` maps assets/go file names to source.
 */
export function buildGoOverlay(probe: GoProbe, assets: Record<string, string>, mount = GO_MOUNT): GoOverlay {
  const ver = parseGoVersion(probe.version);
  if (!ver) throw new DeterminismError(`determinism: go: unrecognised Go version ${JSON.stringify(probe.version)}`);
  const [maj, min] = ver;
  if (maj < GO_MIN_VERSION[0] || (maj === GO_MIN_VERSION[0] && min < GO_MIN_VERSION[1])) {
    throw new DeterminismError(
      `determinism: go: ${probe.version} is too old; the shim needs go${GO_MIN_VERSION.join('.')} or newer (math/rand/v2)`,
    );
  }
  const files: Record<string, string> = {};
  const replace: Record<string, string> = {};
  const src = probe.goroot.replace(/\/$/, '') + '/src';
  for (const f of GO_PATCHED_FILES) {
    const orig = probe.files[f];
    if (orig === undefined) throw new DeterminismError(`determinism: go: GOROOT/src/${f} missing in ${probe.version}`);
    files[`src/${f}`] = patchGoFile(f, orig, probe.version);
    replace[`${src}/${f}`] = `${mount}/src/${f}`;
  }
  for (const a of GO_ADDED) {
    const body = assets[a.asset];
    if (body === undefined) throw new Error(`missing go shim asset ${a.asset}`);
    const rel = `src/${a.pkg}/zz_sluice.go`;
    files[rel] = body + (a.suffix ?? '');
    replace[`${src}/${a.pkg}/zz_sluice.go`] = `${mount}/${rel}`;
  }
  files['overlay.json'] = JSON.stringify({ Replace: replace }, null, 2) + '\n';
  return { files };
}

export function goAssets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of new Set(GO_ADDED.map((x) => x.asset))) out[a] = readFileSync(join(ASSETS, 'go', a), 'utf8');
  return out;
}

export interface GoShim {
  /** Host directory to mount at GO_MOUNT. */
  dir: string;
  version: string;
  gocache: string;
  goflags: string;
  imageId: string;
}

const inflight = new Map<string, Promise<GoShim>>();

/** Generate (or reuse from the cache) the overlay for an image. */
export function prepareGoShim(image: string, log: (m: string) => void = () => {}): Promise<GoShim> {
  let p = inflight.get(image);
  if (!p) {
    p = prepare(image, log).finally(() => inflight.delete(image));
    inflight.set(image, p);
  }
  return p;
}

async function prepare(image: string, log: (m: string) => void): Promise<GoShim> {
  const id = await imageId(image);
  const assets = goAssets();
  const key = createHash('sha256')
    .update(id)
    .update(JSON.stringify(assets))
    .update(GO_SHIM_REVISION)
    .digest('hex')
    .slice(0, 20);
  const dir = join(cacheRoot(), 'determinism', 'go', key);
  const meta = join(dir, 'probe.json');
  if (existsSync(meta)) {
    const m = JSON.parse(readFileSync(meta, 'utf8')) as Omit<GoShim, 'dir' | 'imageId'>;
    return { dir, version: m.version, gocache: m.gocache, goflags: m.goflags, imageId: id };
  }
  log(`determinism: go: generating stdlib overlay for ${image}`);
  const r = await docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-c', GO_PROBE_SCRIPT], {
    allowFail: true,
    timeoutMs: 120_000,
  });
  if (r.code !== 0 && !r.stdout.includes('@@sluice-'))
    throw new DeterminismError(`determinism: go: probing ${image} failed (needs sh and go): ${r.stderr.trim()}`);
  const probe = parseGoProbe(r.stdout);
  const overlay = buildGoOverlay(probe, assets);
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  for (const [rel, body] of Object.entries(overlay.files)) {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    writeFileSync(join(tmp, rel), body);
  }
  const shim: GoShim = { dir, version: probe.version, gocache: probe.gocache, goflags: probe.goflags, imageId: id };
  writeFileSync(join(tmp, 'probe.json'), JSON.stringify({ image, ...shim, dir: undefined }));
  mkdirSync(dirname(dir), { recursive: true });
  try {
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(meta)) throw e; // lost a race with another process: theirs is identical
  }
  return shim;
}

/** Go-relevant variables of a service's env (they change build cache keys). */
export function goBuildEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([k]) => /^(GO|CGO_)/.test(k) && k !== 'GOPROXY')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** The Dockerfile of a warm image: the service image + the overlay + a stdlib (and image module) build. */
export function goWarmDockerfile(image: string, workdir: string, env: Record<string, string>, goflags: string): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const exports = Object.entries({ ...env, GOFLAGS: goflags, GOTOOLCHAIN: 'local', GOPROXY: 'off' })
    .map(([k, v]) => `export ${k}=${q(v)}`)
    .join('; ');
  return [
    `FROM ${image}`,
    `COPY . ${GO_MOUNT}/`,
    // compile only (nothing runs): the stdlib with the overlay, and whatever module the image ships
    `RUN ${exports}; go build std && cd ${q(workdir)} 2>/dev/null && ` +
      `{ go build -o /tmp/sluice-warm/ ./... >/dev/null 2>&1 || true; rm -rf /tmp/sluice-warm; } || true`,
    'LABEL sluice.image=1 sluice.gowarm=1',
    '',
  ].join('\n');
}

const warmInflight = new Map<string, Promise<string>>();

/**
 * A per-(image, overlay, build env) image whose GOCACHE already holds the
 * overlaid stdlib. Service containers run from it: each gets the warm cache in
 * its own copy-on-write layer, so code under test can never write into a cache
 * another run (base, head, other mutants) reads. Built once, by Sluice only.
 */
export function prepareGoWarmImage(
  image: string,
  shim: GoShim,
  workdir: string,
  serviceEnv: Record<string, string>,
  log: (m: string) => void = () => {},
): Promise<string> {
  const env = goBuildEnv(serviceEnv);
  const overlayFlag = `-overlay=${GO_MOUNT}/overlay.json`;
  const base = env.GOFLAGS ?? shim.goflags;
  const goflags = base ? `${base} ${overlayFlag}` : overlayFlag;
  const dockerfile = goWarmDockerfile(image, workdir, { ...env, GOFLAGS: goflags }, goflags);
  const key = createHash('sha256').update(shim.imageId).update(shim.dir).update(dockerfile).digest('hex');
  const tag = `sluice-gowarm-${shim.imageId.replace(/^sha256:/, '').slice(0, 12)}:${key.slice(0, 16)}`;
  let p = warmInflight.get(tag);
  if (!p) {
    p = (async () => {
      if ((await docker(['image', 'inspect', tag], { allowFail: true })).code === 0) return tag;
      log(`determinism: go: building warm stdlib cache image ${tag}`);
      const r = await docker(['build', '-q', '--network', 'none', '-t', tag, '-f', '-', shim.dir], {
        input: dockerfile,
        allowFail: true,
        timeoutMs: 900_000,
      });
      if (r.code !== 0)
        throw new DeterminismError(
          `determinism: go: building ${tag} from ${image} failed:\n${(r.stdout + r.stderr).trim().slice(-2000)}`,
        );
      return tag;
    })().finally(() => warmInflight.delete(tag));
    warmInflight.set(tag, p);
  }
  return p;
}
