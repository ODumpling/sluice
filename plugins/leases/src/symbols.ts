/**
 * Symbol index for a TS/JS tree built on the TypeScript language service (the
 * engine behind tsserver / typescript-language-server). Top-level declarations
 * get stable ids `path#Name`; references are resolved semantically (imports,
 * re-exports, type positions), not by text search.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';

export interface SymbolInfo {
  id: string;
  file: string;
  name: string;
  kind: 'interface' | 'type' | 'class' | 'function' | 'variable' | 'enum';
  exported: boolean;
  startLine: number;
  endLine: number;
  /** Normalized public shape (type text / function signature), used to detect interface changes. */
  signature: string;
}

export interface Reference {
  file: string;
  line: number;
}

const EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);
const SKIP = new Set(['node_modules', '.git', 'dist', '.sluice', 'coverage']);

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (EXTS.has(extname(e.name)) && !e.name.endsWith('.d.ts') && statSync(p).size < 2_000_000)
        out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

const norm = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}();,:<>=|&?])\s*/g, '$1')
    .trim();

function isExported(n: ts.Node): boolean {
  return (
    !!ts.getCombinedModifierFlags(n as ts.Declaration) &&
    (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export) !== 0
  );
}

export class SymbolIndex {
  private readonly service: ts.LanguageService;
  private readonly byId = new Map<string, { info: SymbolInfo; namePos: number }>();

  private constructor(
    readonly root: string,
    readonly files: string[],
  ) {
    const versions = new Map(files.map((f) => [f, '1']));
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => files.map((f) => join(root, f)),
      getScriptVersion: (f) => versions.get(relative(root, f)) ?? '1',
      getScriptSnapshot: (f) => {
        try {
          return ts.ScriptSnapshot.fromString(readFileSync(f, 'utf8'));
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => root,
      getCompilationSettings: () => ({
        allowJs: true,
        checkJs: false,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
      }),
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    for (const f of files) this.indexFile(f);
  }

  static build(root: string): SymbolIndex {
    return new SymbolIndex(root, listFiles(root));
  }

  private indexFile(file: string): void {
    const sf = this.service.getProgram()!.getSourceFile(join(this.root, file));
    if (!sf) return;
    const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const add = (
      name: ts.Identifier,
      node: ts.Node,
      kind: SymbolInfo['kind'],
      signature: string,
      exported: boolean,
    ) => {
      const id = `${file}#${name.text}`;
      this.byId.set(id, {
        info: {
          id,
          file,
          name: name.text,
          kind,
          exported,
          startLine: line(node.getStart(sf)),
          endLine: line(node.getEnd()),
          signature: norm(signature),
        },
        namePos: name.getStart(sf),
      });
    };
    for (const st of sf.statements) {
      const exported = isExported(st);
      if (ts.isInterfaceDeclaration(st))
        add(st.name, st, 'interface', st.getText(sf).replace(/^export\s+/, ''), exported);
      else if (ts.isTypeAliasDeclaration(st))
        add(st.name, st, 'type', st.getText(sf).replace(/^export\s+/, ''), exported);
      else if (ts.isEnumDeclaration(st)) add(st.name, st, 'enum', st.getText(sf).replace(/^export\s+/, ''), exported);
      else if (ts.isClassDeclaration(st) && st.name) {
        const members = st.members
          .filter((m) => !(ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Private))
          .map((m) =>
            ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)
              ? m.getText(sf).replace(/\{[\s\S]*$/, '')
              : m.getText(sf),
          )
          .join(';');
        add(st.name, st, 'class', `class ${st.name.text}{${members}}`, exported);
      } else if (ts.isFunctionDeclaration(st) && st.name) {
        const sig = `${st.name.text}(${st.parameters.map((p) => p.getText(sf)).join(',')})${st.type ? ':' + st.type.getText(sf) : ''}`;
        add(st.name, st, 'function', sig, exported);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const init = d.initializer;
          const sig =
            init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
              ? `${d.name.text}(${init.parameters.map((p) => p.getText(sf)).join(',')})${init.type ? ':' + init.type.getText(sf) : ''}`
              : `${d.name.text}${d.type ? ':' + d.type.getText(sf) : ''}`;
          add(
            d.name,
            st,
            init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? 'function' : 'variable',
            sig,
            exported,
          );
        }
      }
    }
  }

  symbols(): SymbolInfo[] {
    return [...this.byId.values()].map((v) => v.info).sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): SymbolInfo | undefined {
    return this.byId.get(id)?.info;
  }

  /** Top-level symbols whose declaration intersects the given 1-based line ranges. */
  symbolsAt(file: string, ranges: [number, number][]): SymbolInfo[] {
    return this.symbols().filter((s) => s.file === file && ranges.some(([a, b]) => a <= s.endLine && b >= s.startLine));
  }

  /** Semantic references to a symbol outside its own declaration. */
  references(id: string): Reference[] {
    const entry = this.byId.get(id);
    if (!entry) return [];
    const refs = this.service.findReferences(join(this.root, entry.info.file), entry.namePos) ?? [];
    const out: Reference[] = [];
    for (const r of refs) {
      for (const ref of r.references) {
        if (ref.isDefinition) continue;
        const file = relative(this.root, ref.fileName);
        if (file.startsWith('..')) continue;
        const sf = this.service.getProgram()!.getSourceFile(ref.fileName)!;
        out.push({ file, line: sf.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1 });
      }
    }
    const seen = new Set<string>();
    return out
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
