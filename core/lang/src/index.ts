/**
 * Language support shared by every Sluice feature that reads code: the gate's
 * mutation engine, symbol leases, structural rules and campaign codemods.
 *
 * Parsing is tree-sitter via ast-grep. JavaScript/TypeScript grammars ship
 * with `@ast-grep/napi`; Go and C# are registered as dynamic languages from
 * `@ast-grep/lang-go` / `@ast-grep/lang-csharp` (prebuilt parsers, no
 * toolchain needed on the host).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, relative } from 'node:path';
import { Lang, parse, registerDynamicLanguage, type SgRoot } from '@ast-grep/napi';

export type Language = 'javascript' | 'typescript' | 'go' | 'csharp';

export const LANGUAGES: readonly Language[] = ['javascript', 'typescript', 'go', 'csharp'];

const EXT: Record<string, Language> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.go': 'go',
  '.cs': 'csharp',
};

/** File extensions per language. */
export const EXTENSIONS: Record<Language, string[]> = Object.entries(EXT).reduce(
  (acc, [ext, lang]) => ((acc[lang] ??= []).push(ext), acc),
  {} as Record<Language, string[]>,
);

/** Language of a source file by extension (`.d.ts` declaration files are not source). */
export function languageOf(file: string): Language | undefined {
  if (file.endsWith('.d.ts') || file.endsWith('.d.mts') || file.endsWith('.d.cts')) return undefined;
  return EXT[extname(file)];
}

export function isLanguage(v: unknown): v is Language {
  return typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);
}

let registered = false;
function ensureDynamicLanguages(): void {
  if (registered) return;
  const require = createRequire(import.meta.url);
  const go = require('@ast-grep/lang-go') as DynamicModule;
  const csharp = require('@ast-grep/lang-csharp') as DynamicModule;
  registerDynamicLanguage({ go: dyn(go), csharp: dyn(csharp) } as never);
  registered = true;
}

interface DynamicModule {
  libraryPath: string;
  extensions: string[];
  languageSymbol?: string;
  expandoChar?: string;
}

const dyn = (m: DynamicModule) => ({
  libraryPath: m.libraryPath,
  extensions: m.extensions,
  languageSymbol: m.languageSymbol,
  expandoChar: m.expandoChar,
});

/** The ast-grep language handle for `language` (TSX when `file` ends in .tsx/.jsx). */
export function astGrepLang(language: Language, file?: string): Lang | string {
  switch (language) {
    case 'typescript':
      return file?.endsWith('.tsx') ? Lang.Tsx : Lang.TypeScript;
    case 'javascript':
      // tree-sitter-javascript has no JSX-free variant; TSX parses JSX in .jsx files too.
      return file?.endsWith('.jsx') ? Lang.Tsx : Lang.JavaScript;
    case 'go':
      ensureDynamicLanguages();
      return 'go';
    case 'csharp':
      ensureDynamicLanguages();
      return 'csharp';
  }
}

/** Parse source text with tree-sitter. */
export function parseSource(language: Language, text: string, file?: string): SgRoot {
  return parse(astGrepLang(language, file) as Lang, text);
}

/** Directories never scanned, for any language. */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.sluice', 'coverage']);

/** Language-specific generated / vendored directories (path segments). */
const SKIP_SEGMENTS: Partial<Record<Language, string[]>> = {
  go: ['vendor', 'testdata'],
  csharp: ['bin', 'obj'],
};

function skippedFor(language: Language, rel: string): boolean {
  const segs = rel.split(/[\\/]/).slice(0, -1);
  return (SKIP_SEGMENTS[language] ?? []).some((s) => segs.includes(s));
}

/**
 * Source files under `dir` (relative, sorted), optionally restricted to some
 * languages. Skips dependency, build-output and vendored directories.
 */
export function listSourceFiles(dir: string, languages?: readonly Language[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const lang = languageOf(e.name);
        if (!lang || (languages && !languages.includes(lang))) continue;
        const rel = relative(dir, p);
        if (skippedFor(lang, rel) || statSync(p).size >= 2_000_000) continue;
        out.push(rel);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Test files by language convention (used to keep tests out of mutation / lease scope). */
export function isTestFile(file: string): boolean {
  const lang = languageOf(file);
  if (lang === 'go') return file.endsWith('_test.go');
  if (lang === 'csharp') return /(^|[\\/])[^\\/]*Tests?[\\/]|Tests?\.cs$/.test(file);
  return /(^|[\\/])(test|tests|__tests__)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

// ---------------------------------------------------------------- toolchains

export type ToolchainId = 'node' | 'go' | 'dotnet';

export interface Toolchain {
  id: ToolchainId;
  /** Primary languages built by this toolchain. */
  languages: Language[];
  /** Default container image for tests (has the SDK). */
  image: string;
  /** Default test command (run from the repository root, no network). */
  testCommand: string;
  /**
   * Fetch dependencies (run with network at image build time, from a tree that
   * holds only the dependency manifests, before tests run offline).
   */
  prepareCommand: string;
  /** Files that pin dependencies; a change to one means the change touches dependencies. */
  manifest: RegExp;
  /** Environment for prepare and test runs (baked into prepared images). */
  env: Record<string, string>;
}

export const TOOLCHAINS: Record<ToolchainId, Toolchain> = {
  node: {
    id: 'node',
    languages: ['javascript', 'typescript'],
    image: 'node:22-alpine',
    testCommand: 'npm test --silent',
    prepareCommand:
      'if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi',
    manifest: /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/,
    env: {},
  },
  go: {
    id: 'go',
    languages: ['go'],
    image: 'golang:1.27-alpine',
    testCommand: 'go test ./...',
    // every module in the tree (a repo may hold several, or one below the root);
    // `go build std` warms the build cache so offline test runs skip compiling the standard library
    prepareCommand:
      'find . -name go.mod -not -path "*/vendor/*" | sort | while read -r m; do (cd "$(dirname "$m")" && go mod download && go build std) || exit 1; done',
    manifest: /(^|\/)(go\.mod|go\.sum|go\.work|go\.work\.sum)$/,
    env: {},
  },
  dotnet: {
    id: 'dotnet',
    languages: ['csharp'],
    image: 'mcr.microsoft.com/dotnet/sdk:10.0',
    testCommand: 'dotnet test --nologo',
    // every project (no source needed): fills the NuGet global packages folder
    // and obj/, so the implicit restore of `dotnet test` succeeds offline
    prepareCommand:
      'find . \\( -name "*.csproj" -o -name "*.fsproj" -o -name "*.vbproj" \\) | sort | while read -r p; do dotnet restore "$p" || exit 1; done',
    manifest:
      /(^|\/)([^/]+\.(csproj|fsproj|vbproj|sln|slnx)|packages\.lock\.json|Directory\.(Packages|Build)\.(props|targets)|global\.json|NuGet\.config|nuget\.config)$/,
    env: {
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      MSBUILDDISABLENODEREUSE: '1',
    },
  },
};

/** Any toolchain's dependency manifest. */
export function isDependencyManifest(file: string): boolean {
  return Object.values(TOOLCHAINS).some((t) => t.manifest.test(file));
}

/**
 * Detect the toolchain of a project directory from its root files: `go.mod`
 * → go, a `*.csproj`/`*.sln`/`*.slnx` (or `global.json`) → dotnet,
 * `package.json` → node. Returns undefined when nothing matches.
 */
export function detectToolchain(dir: string): Toolchain | undefined {
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir);
  if (names.includes('go.mod') || names.includes('go.work')) return TOOLCHAINS.go;
  if (names.some((n) => /\.(csproj|fsproj|sln|slnx)$/.test(n)) || names.includes('global.json'))
    return TOOLCHAINS.dotnet;
  if (names.includes('package.json')) return TOOLCHAINS.node;
  // one level down (e.g. src/App/App.csproj, cmd/… go.mod in a subdir)
  for (const n of names) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    try {
      if (!statSync(p).isDirectory()) continue;
      const sub = readdirSync(p);
      if (sub.includes('go.mod')) return TOOLCHAINS.go;
      if (sub.some((s) => /\.(csproj|fsproj)$/.test(s))) return TOOLCHAINS.dotnet;
    } catch {
      // unreadable: ignore
    }
  }
  return undefined;
}

/** Dependency manifests of `toolchain` under `dir` (relative, sorted; skips build output / vendored dirs). */
export function findManifests(dir: string, toolchain?: Toolchain): string[] {
  const out: string[] = [];
  const skip = new Set([...SKIP_DIRS, 'bin', 'obj', 'vendor', 'testdata']);
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = join(d, e.name);
      const rel = relative(dir, p).split('\\').join('/');
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && (toolchain ? toolchain.manifest.test(rel) : isDependencyManifest(rel))) out.push(rel);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/**
 * The prepare (dependency fetch) command a tree needs before its tests can run
 * offline, or undefined when it needs none: Go when there is a go.mod (modules
 * are downloaded and the build cache is warmed), .NET when there is a project
 * (test frameworks are packages). Node trees get none by default — opt in
 * explicitly (`TOOLCHAINS.node.prepareCommand`).
 */
export function defaultPrepare(toolchain: Toolchain | undefined, dir: string): string | undefined {
  if (!toolchain || toolchain.id === 'node') return undefined;
  const manifests = findManifests(dir, toolchain);
  const project = toolchain.id === 'go' ? /(^|\/)go\.mod$/ : /\.(csproj|fsproj|vbproj)$/;
  return manifests.some((m) => project.test(m)) ? toolchain.prepareCommand : undefined;
}

/** Test files of a toolchain's languages (all languages when undefined). */
export function isToolchainTestFile(toolchain: Toolchain | undefined, file: string): boolean {
  const lang = languageOf(file);
  return isTestFile(file) && (!toolchain || (!!lang && toolchain.languages.includes(lang)));
}

/** Non-test source files of a toolchain's languages. */
export function isToolchainSourceFile(toolchain: Toolchain | undefined, file: string): boolean {
  const lang = languageOf(file);
  return !!lang && (!toolchain || toolchain.languages.includes(lang)) && !isTestFile(file);
}

/** Go module path declared in a go.mod (undefined when absent). */
export function goModulePath(goModText: string): string | undefined {
  return /^\s*module\s+("?)([^\s"]+)\1\s*$/m.exec(goModText)?.[2];
}

export function readGoModule(dir: string): string | undefined {
  const f = join(dir, 'go.mod');
  return existsSync(f) ? goModulePath(readFileSync(f, 'utf8')) : undefined;
}
