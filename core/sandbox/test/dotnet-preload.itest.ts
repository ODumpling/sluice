// Native regression tests for the dotnet determinism preload: a C program
// (fixtures/preload-test) exercises fd tracking (dup*, fcntl, close_range,
// raw close + fd reuse, pread/readv/preadv), negative clock values and
// dlsym(RTLD_NEXT) under the glibc and musl builds of the library.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docker } from '@sluice-dev/sandbox';
import { prepareDotnetShim } from '../src/determinism/dotnet.js';

const TEST_DIR = join(import.meta.dirname, 'fixtures', 'preload-test');

const LIBCS = [
  { libc: 'musl', image: 'alpine:3.20', setup: 'apk add --no-cache -q gcc musl-dev >/dev/null' },
  {
    libc: 'glibc',
    image: 'debian:bookworm-slim',
    setup:
      'apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends gcc libc6-dev >/dev/null',
  },
] as const;

describe('dotnet preload (native)', () => {
  for (const { libc, image, setup } of LIBCS) {
    it(`${libc}: fd tracking, clock normalization, dlsym passthrough, seeded streams`, async () => {
      const arch = (await docker(['version', '--format', '{{.Server.Arch}}'])).stdout.trim();
      const shim = await prepareDotnetShim(arch);
      const runs = [1, 1, 2].map((seed) => `LD_PRELOAD=/sluice/libsluice-${libc}.so SLUICE_SEED=${seed} /tmp/pt`);
      const r = await docker(
        [
          'run',
          '--rm',
          '-v',
          `${shim.dir}:/sluice:ro`,
          '-v',
          `${TEST_DIR}:/t:ro`,
          '-e',
          'SLUICE_NOW_MS=-1500',
          image,
          'sh',
          '-c',
          [
            `set -e`,
            setup,
            'gcc -O1 -o /tmp/pt /t/preload_test.c',
            ...runs.map((c) => `${c} || true`),
            // SDK detection: argv under <dotnet root>/sdk/ (root = dir of the running dotnet host) is an SDK process
            'mkdir -p /opt/dn/sdk/9.9.9 /work/sdk && cp /tmp/pt /opt/dn/dotnet && ln -s /opt/dn /opt/dnlink',
            'touch /opt/dn/sdk/9.9.9/MSBuild.dll /opt/dn/sdk/9.9.9/csc.dll /work/sdk/App.dll /work/App.dll',
            `export LD_PRELOAD=/sluice/libsluice-${libc}.so`,
            'echo "sdk-msbuild $(/opt/dn/dotnet /opt/dn/sdk/9.9.9/MSBuild.dll)"',
            'echo "sdk-symlink $(/opt/dn/dotnet /opt/dnlink/sdk/9.9.9/csc.dll)"',
            'echo "sdk-verb $(/opt/dn/dotnet build)"',
            'echo "app-sdk-dir $(/opt/dn/dotnet /work/sdk/App.dll)"',
            'echo "app-exec $(/opt/dn/dotnet exec /work/App.dll)"',
          ].join('\n'),
        ],
        { allowFail: true, timeoutMs: 600_000 },
      );
      const out = r.stdout + r.stderr;
      expect(out).not.toMatch(/FAIL/);
      const seeded = [...out.matchAll(/^seeded ([0-9a-f]+)$/gm)].map((m) => m[1]);
      expect(seeded).toHaveLength(3);
      expect(out.match(/^ok$/gm)).toHaveLength(3);
      expect(seeded[1]).toBe(seeded[0]); // same seed → same bytes
      expect(seeded[2]).not.toBe(seeded[0]); // new seed → new bytes
      // SDK processes keep the real clock; apps (even under a dir named sdk) are shimmed
      expect(out).toContain('sdk-msbuild frozen 0');
      expect(out).toContain('sdk-symlink frozen 0');
      expect(out).toContain('sdk-verb frozen 0');
      expect(out).toContain('app-sdk-dir frozen 1');
      expect(out).toContain('app-exec frozen 1');
    });
  }
});
