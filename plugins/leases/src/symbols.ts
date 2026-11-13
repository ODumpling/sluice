/**
 * Multi-language symbol index. Each language has a provider:
 *
 * - TypeScript / JavaScript: the TypeScript language service (semantic references).
 * - Go: tree-sitter, package-aware (package = directory, imports mapped through go.mod).
 * - C#: tree-sitter, namespace-aware (namespaces, `using` / `global using` / aliases / `using static`).
 *
 * Symbols get stable ids `path#Name` (Go methods `path#Recv.Method`, C# nested
 * types `path#Outer.Inner`). A mixed repository indexes every language.
 */
import { languageOf, listSourceFiles, type Language } from '@sluice-dev/lang';
import { CSharpProvider } from './lang-csharp.js';
import { GoProvider } from './lang-go.js';
import { TypeScriptProvider } from './lang-typescript.js';
import type { Reference, SymbolInfo, SymbolProvider, SymbolSpan } from './model.js';

export type { Reference, SymbolInfo, SymbolKind, SymbolSpan } from './model.js';

const spansOf = (s: SymbolInfo): SymbolSpan[] =>
  s.parts ?? [{ file: s.file, startLine: s.startLine, endLine: s.endLine }];

/** Is [a, b] fully covered by the union of `cover` intervals? */
function covered(a: number, b: number, cover: [number, number][]): boolean {
  let pos = a;
  for (const [s, e] of [...cover].sort((x, y) => x[0] - y[0])) {
    if (s > pos) break;
    if (e >= pos) pos = e + 1;
    if (pos > b) return true;
  }
  return pos > b;
}

export interface BuildOptions {
  /** Only index these languages (default: all). */
  languages?: readonly Language[];
}

export class SymbolIndex {
  private readonly byId = new Map<string, { info: SymbolInfo; provider: SymbolProvider }>();
  private readonly sorted: SymbolInfo[];
  private readonly children = new Map<string, SymbolInfo[]>();
  private readonly byFile = new Map<string, SymbolInfo[]>();

  private constructor(
    readonly root: string,
    readonly files: string[],
    providers: SymbolProvider[],
  ) {
    for (const p of providers) for (const info of p.symbols) this.byId.set(info.id, { info, provider: p });
    this.sorted = [...this.byId.values()].map((v) => v.info).sort((a, b) => a.id.localeCompare(b.id));
    const push = (m: Map<string, SymbolInfo[]>, k: string, s: SymbolInfo) => {
      const a = m.get(k);
      if (a) a.push(s);
      else m.set(k, [s]);
    };
    for (const s of this.sorted) {
      if (s.container) push(this.children, s.container, s);
      for (const f of new Set(spansOf(s).map((p) => p.file))) push(this.byFile, f, s);
    }
  }

  static build(root: string, opts: BuildOptions = {}): SymbolIndex {
    const files = listSourceFiles(root, opts.languages);
    const of = (...langs: Language[]) => files.filter((f) => langs.includes(languageOf(f)!));
    const providers: SymbolProvider[] = [];
    const tsFiles = of('typescript', 'javascript');
    if (tsFiles.length) providers.push(new TypeScriptProvider(root, tsFiles));
    const goFiles = of('go');
    if (goFiles.length) providers.push(new GoProvider(root, goFiles));
    const csFiles = of('csharp');
    if (csFiles.length) providers.push(new CSharpProvider(root, csFiles));
    return new SymbolIndex(root, files, providers);
  }

  symbols(): SymbolInfo[] {
    return [...this.sorted];
  }

  get(id: string): SymbolInfo | undefined {
    return this.byId.get(id)?.info;
  }

  /**
   * Symbols whose declaration intersects the given 1-based line ranges. A
   * container (C# outer type) is only included when the range touches it
   * outside its nested symbols; each part of a partial type counts.
   */
  symbolsAt(file: string, ranges: [number, number][]): SymbolInfo[] {
    return (this.byFile.get(file) ?? []).filter((s) =>
      spansOf(s).some(
        (p) =>
          p.file === file &&
          ranges.some(([a, b]) => {
            const lo = Math.max(a, p.startLine);
            const hi = Math.min(b, p.endLine);
            if (lo > hi) return false;
            const kids = (this.children.get(s.id) ?? []).flatMap((c) =>
              spansOf(c)
                .filter((cp) => cp.file === file)
                .map((cp) => [cp.startLine, cp.endLine] as [number, number]),
            );
            return !kids.length || !covered(lo, hi, kids);
          }),
      ),
    );
  }

  /** References to a symbol outside its own declaration name. */
  references(id: string): Reference[] {
    const entry = this.byId.get(id);
    if (!entry) return [];
    const seen = new Set<string>();
    return entry.provider
      .references(id)
      .filter((r) => (seen.has(`${r.file}:${r.line}`) ? false : (seen.add(`${r.file}:${r.line}`), true)))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  /** Symbols (in other declarations) that use `id` — who is affected if it changes. */
  dependents(id: string): SymbolInfo[] {
    const out = new Map<string, SymbolInfo>();
    for (const r of this.references(id))
      for (const s of this.symbolsAt(r.file, [[r.line, r.line]])) if (s.id !== id) out.set(s.id, s);
    return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export interface InterfaceChange {
  id: string;
  kind: 'changed' | 'removed' | 'added';
  before?: string;
  after?: string;
}

/** Exported symbols whose public shape differs between two indexes. */
export function interfaceChanges(base: SymbolIndex, head: SymbolIndex, only?: Set<string>): InterfaceChange[] {
  const out: InterfaceChange[] = [];
  const b = new Map(
    base
      .symbols()
      .filter((s) => s.exported)
      .map((s) => [s.id, s]),
  );
  const h = new Map(
    head
      .symbols()
      .filter((s) => s.exported)
      .map((s) => [s.id, s]),
  );
  for (const [id, s] of b) {
    if (only && !only.has(id)) continue;
    const n = h.get(id);
    if (!n) out.push({ id, kind: 'removed', before: s.signature });
    else if (n.signature !== s.signature) out.push({ id, kind: 'changed', before: s.signature, after: n.signature });
  }
  for (const [id, s] of h)
    if (!b.has(id) && (!only || only.has(id))) out.push({ id, kind: 'added', after: s.signature });
  return out.sort((a, b2) => a.id.localeCompare(b2.id));
}
