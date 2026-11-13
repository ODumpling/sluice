// Hermetic tests for the determinism shim plumbing (no Docker).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOTNET_BUILD,
  DeterminismError,
  GO_PATCHED_FILES,
  buildGoOverlay,
  dotnetCommand,
  parseGoProbe,
  parseGoVersion,
  patchGoFile,
  type GoProbe,
} from '../src/determinism/index.js';
import { goAssets, goBuildEnv, goWarmDockerfile } from '../src/determinism/go.js';

// Excerpts of the real GOROOT sources (go1.27) around each patch point.
const TIME_GO = `package time

// x/tools uses a linkname of time.Now in its tests. No harm done.
//go:linkname Now

// Now returns the current local time.
func Now() Time {
	sec, nsec, mono := runtimeNow()
	return Time{hasMonotonic | uint64(sec)<<nsecShift | uint64(nsec), mono, Local}
}

func Since(t Time) Duration {
	return Now().Sub(t)
}
`;
const FILE_GO = `package os

// Write writes len(b) bytes from b to the File.
func (f *File) Write(b []byte) (n int, err error) {
	if err := f.checkValid("write"); err != nil {
		return 0, err
	}
	n, e := f.write(b)
	return n, e
}

func (f *File) WriteString(s string) (n int, err error) {
	return f.Write([]byte(s))
}
`;
const RAND_GO = `package rand

//go:linkname runtime_rand runtime.rand
func runtime_rand() uint64

func (*runtimeSource) Uint64() uint64 {
	return runtime_rand()
}
`;

const probe = (over: Partial<GoProbe> = {}): GoProbe => ({
  goroot: '/usr/local/go',
  version: 'go1.27.4',
  gocache: '/root/.cache/go-build',
  goflags: '',
  files: {
    'time/time.go': TIME_GO,
    'os/file.go': FILE_GO,
    'math/rand/rand.go': RAND_GO,
    'math/rand/v2/rand.go': RAND_GO,
  },
  ...over,
});

describe('go overlay', () => {
  it('renames time.Now so the shim can provide the frozen one', () => {
    const out = patchGoFile('time/time.go', TIME_GO, 'go1.27.4');
    expect(out).toContain('func sluiceRealNow() Time {');
    expect(out).not.toMatch(/^func Now\(\)/m);
    expect(out).toContain('return Now().Sub(t)'); // internal callers now hit the frozen Now
    expect(out).toContain('//go:linkname Now'); // still satisfied by zz_sluice.go
  });

  it('taps (*os.File).Write for fd 1 before the write', () => {
    const out = patchGoFile('os/file.go', FILE_GO, 'go1.27.4');
    expect(out).toMatch(
      /func \(f \*File\) Write\(b \[\]byte\) \(n int, err error\) \{\n\tif SluiceStdoutTap != nil && .*f\.pfd\.Sysfd == 1 \{\n\t\tSluiceStdoutTap\(b\)\n\t\}\n\tif err := f\.checkValid/,
    );
    expect(out.match(/SluiceStdoutTap\(b\)/g)).toHaveLength(1); // WriteString goes through Write
  });

  it('reroutes the linknamed runtime_rand of math/rand and math/rand/v2', () => {
    for (const f of ['math/rand/rand.go', 'math/rand/v2/rand.go']) {
      const out = patchGoFile(f, RAND_GO, 'go1.27.4');
      expect(out).toContain('//go:linkname sluiceRuntimeRand runtime.rand\nfunc sluiceRuntimeRand() uint64');
      expect(out).toContain('return runtime_rand()'); // resolved by zz_sluice.go
    }
  });

  it('fails loudly when a patch point is missing or ambiguous', () => {
    const missing = () =>
      patchGoFile('time/time.go', TIME_GO.replace('func Now() Time {', 'func Now2() Time {'), 'go1.99.0');
    expect(missing).toThrow(DeterminismError);
    expect(missing).toThrow(
      /GOROOT\/src\/time\/time\.go of go1\.99\.0: `func Now\(\) Time \{` not found.*go1\.22 and newer/,
    );
    expect(() => patchGoFile('os/file.go', FILE_GO + FILE_GO, 'go1.30')).toThrow(/found 2 times/);
    expect(() => patchGoFile('time/time.go', patchGoFile('time/time.go', TIME_GO, 'v'), 'v')).toThrow(
      /already patched/,
    );
  });

  it('builds overlay.json mapping GOROOT paths to the mounted overlay', () => {
    const { files } = buildGoOverlay(probe(), goAssets(), '/sluice/go');
    const overlay = JSON.parse(files['overlay.json']!) as { Replace: Record<string, string> };
    expect(Object.keys(overlay.Replace).sort()).toEqual(
      [
        ...GO_PATCHED_FILES,
        'time/zz_sluice.go',
        'os/zz_sluice.go',
        'math/rand/zz_sluice.go',
        'math/rand/v2/zz_sluice.go',
        'crypto/rand/zz_sluice.go',
        'net/http/zz_sluice.go',
      ]
        .map((f) => `/usr/local/go/src/${f}`)
        .sort(),
    );
    for (const [from, to] of Object.entries(overlay.Replace)) {
      expect(to).toBe(from.replace('/usr/local/go/src/', '/sluice/go/src/'));
      expect(files[to.replace('/sluice/go/', '')]).toBeDefined();
    }
    expect(files['src/net/http/zz_sluice.go']).toMatch(/^package http$/m);
    expect(files['src/crypto/rand/zz_sluice.go']).toMatch(/^package rand$/m);
    // each math/rand flavour gets its own stream label
    const labels = ['math/rand', 'math/rand/v2'].map(
      (p) => /const sluiceStreamLabel = (0x[0-9a-f]+)/.exec(files[`src/${p}/zz_sluice.go`]!)?.[1],
    );
    expect(labels[0]).toBeDefined();
    expect(labels[0]).not.toBe(labels[1]);
  });

  it('rejects toolchains older than go1.22 and unreadable versions', () => {
    expect(() => buildGoOverlay(probe({ version: 'go1.21.13' }), goAssets())).toThrow(
      /go1\.21\.13 is too old.*go1\.22/,
    );
    expect(() => buildGoOverlay(probe({ version: 'weird' }), goAssets())).toThrow(/unrecognised Go version/);
    expect(() => buildGoOverlay(probe({ files: { 'time/time.go': TIME_GO } }), goAssets())).toThrow(
      /os\/file\.go missing/,
    );
  });

  it('parses Go versions', () => {
    expect(parseGoVersion('go1.27.4')).toEqual([1, 27]);
    expect(parseGoVersion('go1.22rc1')).toEqual([1, 22]);
    expect(parseGoVersion('devel go1.28-4f2a X:nocoverageredesign')).toEqual([1, 28]);
    expect(parseGoVersion('1.22')).toBeUndefined();
  });

  it('parses the probe output', () => {
    const out = [
      '@@sluice-goroot:/usr/local/go',
      '@@sluice-goversion:go1.27.4',
      '@@sluice-gocache:/root/.cache/go-build',
      '@@sluice-goflags:-buildvcs=false',
      '@@sluice-file:time/time.go',
      TIME_GO,
      '',
      '@@sluice-file:os/file.go',
      FILE_GO,
      '@@sluice-file:math/rand/v2/rand.go',
      '',
    ].join('\n');
    const p = parseGoProbe(out);
    expect(p).toMatchObject({
      goroot: '/usr/local/go',
      version: 'go1.27.4',
      gocache: '/root/.cache/go-build',
      goflags: '-buildvcs=false',
    });
    expect(Object.keys(p.files)).toEqual(['time/time.go', 'os/file.go']);
    expect(p.files['time/time.go']!.trimEnd()).toBe(TIME_GO.trimEnd());
    expect(() => parseGoProbe('@@sluice-error:no go command on PATH\n')).toThrow(/no go command on PATH/);
    expect(() => parseGoProbe('nothing')).toThrow(/GOROOT\/GOVERSION/);
  });

  it('shim sources declare the identifiers the patches reference', () => {
    const a = goAssets();
    expect(a['time.go']).toMatch(/^func Now\(\) Time \{$/m);
    expect(a['time.go']).toContain('sluiceRealNow()');
    expect(a['time.go']).toContain('func SluiceSetNowMs(ms int64)');
    expect(a['os.go']).toContain('var SluiceStdoutTap func([]byte)');
    expect(a['mathrand.go']).toMatch(/^func runtime_rand\(\) uint64 \{$/m);
    expect(a['mathrand.go']).toContain('sluiceRuntimeRand()');
    expect(a['http.go']).toContain('os.SluiceStdoutTap = sluiceTap');
    expect(a['http.go']).toContain('time.SluiceSetNowMs(');
  });
});

describe('go warm-cache image', () => {
  it('compiles the overlaid stdlib with the service build env, offline, into the image layer', () => {
    const env = goBuildEnv({ CGO_ENABLED: '0', GOPROXY: 'https://x', PORT: '1', GOFLAGS: "-tags=it's" });
    expect(env).toEqual({ CGO_ENABLED: '0', GOFLAGS: "-tags=it's" });
    const df = goWarmDockerfile('golang:1.27-alpine', '/app', env, "-tags=it's -overlay=/sluice/go/overlay.json");
    expect(df).toMatch(/^FROM golang:1\.27-alpine\nCOPY \. \/sluice\/go\/\nRUN /);
    expect(df).toContain(`export GOFLAGS='-tags=it'\\''s -overlay=/sluice/go/overlay.json'`);
    expect(df).toContain("export CGO_ENABLED='0'");
    expect(df).toContain("export GOTOOLCHAIN='local'; export GOPROXY='off'; go build std");
    expect(df).toContain("cd '/app'");
    expect(df).not.toMatch(/VOLUME|ENTRYPOINT|CMD/); // keeps the service image's own
  });
});

describe('dotnet shim', () => {
  it('keeps docker entrypoint/command semantics under sluice-init', () => {
    const cfg = { arch: 'arm64', entrypoint: ['dotnet'], cmd: ['App.dll'] };
    expect(dotnetCommand(cfg, undefined)).toEqual(['dotnet', 'App.dll']);
    expect(dotnetCommand(cfg, ['Other.dll', '--x'])).toEqual(['dotnet', 'Other.dll', '--x']);
    expect(dotnetCommand({ arch: 'amd64', entrypoint: [], cmd: ['dotnet', 'run'] }, undefined)).toEqual([
      'dotnet',
      'run',
    ]);
    expect(() => dotnetCommand({ arch: 'amd64', entrypoint: [], cmd: [] }, undefined)).toThrow(DeterminismError);
  });

  it('builds a static init plus a preload library per libc', () => {
    expect(DOTNET_BUILD.musl.script).toContain('-static -o /out/sluice-init');
    expect(DOTNET_BUILD.musl.script).toContain('/out/libsluice-musl.so');
    expect(DOTNET_BUILD.glibc.script).toContain('/out/libsluice-glibc.so');
  });

  it('the preload never freezes monotonic clocks', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'assets', 'dotnet', 'sluice-preload.c'), 'utf8');
    const frozen = /static int frozen_clock\(clockid_t c\) \{([^}]*)\}/.exec(src)![1]!;
    expect(frozen).toContain('CLOCK_REALTIME');
    expect(frozen).not.toMatch(/MONOTONIC|BOOTTIME|CPUTIME/);
  });
});
