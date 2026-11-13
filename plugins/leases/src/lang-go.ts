/**
 * Go symbols from tree-sitter (no gopls / Go toolchain needed).
 *
 * Symbols: top-level funcs (`path#Name`), methods (`path#Recv.Method`, path =
 * the file declaring the method), types (struct / interface / defined / alias),
 * consts and vars (one symbol per name). `exported` = Go exported identifier.
 *
 * References are package-aware: package = directory (+ package clause, so
 * `foo_test` is separate); unqualified identifiers resolve to the package's
 * top-level declarations unless shadowed by a local (params, results,
 * receivers, type params, `:=`, `var`/`const`/`type` in blocks, range / type
 * switch / select variables); `alias.Name` resolves through the file's imports,
 * mapped to directories via the nearest go.mod's module path (root or nested
 * modules; go.work members are found the same way). Method selectors `x.M`
 * resolve when x's type is syntactically known (param / var type, composite
 * literal, `new(T)`, `&T{}`, conversion, result of an indexed func/method,
 * methods promoted through embedded fields); otherwise a *call* `x.M()`
 * matches the unique indexed method named M, if there is exactly one.
 * Embedded struct fields and embedded interfaces count as type references.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { goModulePath, parseSource } from '@sluice-dev/lang';
import {
  RefSink,
  Scope,
  endLineOf,
  lineOf,
  textWithout,
  ws,
  type Reference,
  type SgNode,
  type SymbolInfo,
  type SymbolKind,
  type SymbolProvider,
} from './model.js';

interface GoFile {
  file: string;
  text: string;
  root: SgNode;
  pkg: GoPackage;
  /** Import name → package (null: outside the index, e.g. stdlib). */
  imports: Map<string, GoPackage | null>;
  importPaths: { name: string | undefined; path: string }[];
  dots: GoPackage[];
}

interface GoDecl {
  id: string;
  name: string;
  kind: SymbolKind;
  file: GoFile;
  /** var / const declared type, func/method result, alias / defined type target. */
  typeNode?: SgNode | null;
  valueNode?: SgNode | null;
  resultNode?: SgNode | null;
  embedded?: SgNode[];
  alias?: SgNode | null;
}

interface GoPackage {
  key: string;
  dir: string;
  name: string;
  files: GoFile[];
  decls: Map<string, GoDecl>;
  /** `Recv.Method` → decl. */
  methods: Map<string, GoDecl>;
}

/** Known type of an expression: an indexed type decl, or a type outside the index. */
type TypeRef = { decl?: GoDecl } | 'unknown';

interface Local {
  /** Type parameter or local type name (shadows package-level types). */
  typeparam?: boolean;
  type?: TypeRef;
}

const TYPE_KINDS = new Set<SymbolKind>(['struct', 'interface', 'type']);
const isExported = (name: string) => /^\p{Lu}/u.test(name);

function guessPackageName(path: string): string {
  const segs = path.split('/');
  let last = segs.pop() ?? path;
  if (/^v\d+$/.test(last) && segs.length) last = segs.pop()!;
  return last
    .replace(/\.v\d+$/, '')
    .replace(/^go-/, '')
    .replace(/[-.]go$/, '')
    .replace(/[^\w]/g, '_');
}

function paramTypes(list: SgNode | null | undefined): string {
  if (!list) return '';
  const out: string[] = [];
  for (const p of list.namedChildren()) {
    const t = p.field('type');
    if (!t) continue;
    const text = ws(textWithout(t));
    if (p.kind() === 'variadic_parameter_declaration') out.push('...' + text);
    else for (let i = 0; i < Math.max(1, p.fieldChildren('name').length); i++) out.push(text);
  }
  return out.join(',');
}

function resultText(r: SgNode | null | undefined): string {
  if (!r) return '';
  return r.kind() === 'parameter_list' ? `(${paramTypes(r)})` : ws(textWithout(r));
}

export class GoProvider implements SymbolProvider {
  readonly symbols: SymbolInfo[] = [];
  private readonly files = new Map<string, GoFile>();
  private readonly packages = new Map<string, GoPackage>();
  private readonly byImportPath = new Map<string, GoPackage>();
  private readonly declById = new Map<string, GoDecl>();
  private readonly methodsByName = new Map<string, GoDecl[]>();
  private readonly refCache = new Map<string, RefSink>();
  private readonly modCache = new Map<string, { path: string; dir: string } | null>();

  constructor(
    readonly root: string,
    files: string[],
  ) {
    for (const file of files) this.load(file);
    for (const pkg of this.packages.values()) {
      const mod = this.moduleOf(pkg.dir);
      if (!mod || pkg.name.endsWith('_test')) continue;
      const rel = pkg.dir === mod.dir ? '' : pkg.dir.slice(mod.dir === '.' ? 0 : mod.dir.length + 1);
      const ip = rel ? `${mod.path}/${rel}` : mod.path;
      if (!this.byImportPath.has(ip) || pkg.name !== 'main') this.byImportPath.set(ip, pkg);
    }
    for (const f of this.files.values()) this.resolveImports(f);
    for (const f of this.files.values()) this.collect(f);
  }

  // ------------------------------------------------------------------ loading

  private load(file: string): void {
    const text = readFileSync(join(this.root, file), 'utf8');
    const root = parseSource('go', text, file).root();
    const clause = root.find({ rule: { kind: 'package_clause' } });
    const name = clause?.namedChildren()[0]?.text();
    if (!name) return;
    const dir = dirname(file);
    const key = `${dir}\0${name}`;
    let pkg = this.packages.get(key);
    if (!pkg) this.packages.set(key, (pkg = { key, dir, name, files: [], decls: new Map(), methods: new Map() }));
    const importPaths = root.findAll({ rule: { kind: 'import_spec' } }).map((s) => ({
      name: s.field('name')?.text(),
      path: (s.field('path')?.text() ?? '').replace(/^["`]|["`]$/g, ''),
    }));
    const f: GoFile = { file, text, root, pkg, imports: new Map(), importPaths, dots: [] };
    pkg.files.push(f);
    this.files.set(file, f);
  }

  private moduleOf(dir: string): { path: string; dir: string } | null {
    const hit = this.modCache.get(dir);
    if (hit !== undefined) return hit;
    let found: { path: string; dir: string } | null = null;
    const gm = join(this.root, dir, 'go.mod');
    if (existsSync(gm)) {
      const path = goModulePath(readFileSync(gm, 'utf8'));
      if (path) found = { path, dir };
    }
    if (!found && dir !== '.' && dir !== '') found = this.moduleOf(dirname(dir));
    this.modCache.set(dir, found);
    return found;
  }

  private resolveImports(f: GoFile): void {
    for (const { name, path } of f.importPaths) {
      const target = this.byImportPath.get(path) ?? null;
      if (name === '_') continue;
      if (name === '.') {
        if (target) f.dots.push(target);
        continue;
      }
      f.imports.set(name ?? target?.name ?? guessPackageName(path), target);
    }
  }

  // ------------------------------------------------------------------ symbols

  private collect(f: GoFile): void {
    const byId = new Map<string, SymbolInfo>();
    const add = (decl: GoDecl, node: SgNode, signature: string, exported: boolean, register = true) => {
      const span = { file: f.file, startLine: lineOf(node), endLine: endLineOf(node) };
      const prev = byId.get(decl.id);
      if (prev) {
        // e.g. several `func init()` in one file: one symbol with several parts
        prev.parts = [...(prev.parts ?? [{ file: prev.file, startLine: prev.startLine, endLine: prev.endLine }]), span];
        prev.signature += ';' + signature;
        return;
      }
      const info: SymbolInfo = {
        id: decl.id,
        name: decl.name,
        kind: decl.kind,
        exported,
        ...span,
        signature,
        language: 'go',
      };
      byId.set(decl.id, info);
      this.symbols.push(info);
      this.declById.set(decl.id, decl);
      if (register) f.pkg.decls.set(decl.name, decl);
    };

    for (const top of f.root.namedChildren()) {
      const k = top.kind();
      if (k === 'function_declaration') {
        const name = top.field('name')?.text();
        if (!name || name === '_') continue;
        const decl: GoDecl = {
          id: `${f.file}#${name}`,
          name,
          kind: 'function',
          file: f,
          resultNode: top.field('result'),
        };
        const tp = top.field('type_parameters');
        const sig = `func ${name}${tp ? ws(textWithout(tp)) : ''}(${paramTypes(top.field('parameters'))})${resultText(top.field('result'))}`;
        add(decl, top, sig, isExported(name), name !== 'init');
      } else if (k === 'method_declaration') {
        const name = top.field('name')?.text();
        const recvType = top.field('receiver')?.namedChildren()[0]?.field('type');
        const recv = recvType ? baseTypeName(recvType) : undefined;
        if (!name || !recv) continue;
        const decl: GoDecl = {
          id: `${f.file}#${recv}.${name}`,
          name,
          kind: 'method',
          file: f,
          resultNode: top.field('result'),
        };
        const sig = `func (${ws(textWithout(recvType!))}) ${name}(${paramTypes(top.field('parameters'))})${resultText(top.field('result'))}`;
        add(decl, top, sig, isExported(name), false);
        f.pkg.methods.set(`${recv}.${name}`, decl);
        const same = this.methodsByName.get(name) ?? [];
        same.push(decl);
        this.methodsByName.set(name, same);
      } else if (k === 'type_declaration') {
        const specs = top.namedChildren().filter((c) => c.kind() === 'type_spec' || c.kind() === 'type_alias');
        for (const spec of specs) {
          const name = spec.field('name')?.text();
          const type = spec.field('type');
          if (!name || name === '_' || !type) continue;
          const tk = type.kind();
          const isAlias = spec.kind() === 'type_alias';
          const kind: SymbolKind =
            !isAlias && tk === 'struct_type' ? 'struct' : !isAlias && tk === 'interface_type' ? 'interface' : 'type';
          const tp = spec.field('type_parameters');
          const head = `type ${name}${tp ? ws(textWithout(tp)) : ''}`;
          const decl: GoDecl = { id: `${f.file}#${name}`, name, kind, file: f };
          let sig: string;
          if (kind === 'struct') {
            const fields: string[] = [];
            decl.embedded = [];
            for (const fd of type.findAll({ rule: { kind: 'field_declaration' } })) {
              if (fd.parent()?.parent()?.id() !== type.id()) continue; // only this struct's own fields
              const ft = fd.field('type');
              if (!ft) continue;
              const tag = fd.field('tag')?.text() ?? '';
              const names = fd.fieldChildren('name').map((n) => n.text());
              const tt = ws(textWithout(ft));
              if (!names.length) {
                decl.embedded.push(ft);
                fields.push(`${tt} ${tag}`.trim());
              } else for (const n of names.filter(isExported)) fields.push(`${n} ${tt} ${tag}`.trim());
            }
            sig = `${head} struct{${fields.join(';')}}`;
          } else if (kind === 'interface') {
            const elems = type
              .namedChildren()
              .filter((c) => c.kind() !== 'comment')
              .map((c) => ws(textWithout(c)))
              .sort();
            sig = `${head} interface{${elems.join(';')}}`;
          } else {
            decl.alias = type;
            sig = `${head}${isAlias ? '=' : ' '}${ws(textWithout(type))}`;
          }
          add(decl, specs.length === 1 && !hasParen(top) ? top : spec, sig, isExported(name));
        }
      } else if (k === 'const_declaration' || k === 'var_declaration') {
        const isConst = k === 'const_declaration';
        const list = isConst ? top : (top.namedChildren().find((c) => c.kind() === 'var_spec_list') ?? top);
        const specs = list.namedChildren().filter((c) => c.kind() === 'const_spec' || c.kind() === 'var_spec');
        const single = specs.length === 1 && !hasParen(top);
        let lastType = '';
        let lastValue = '';
        specs.forEach((spec, i) => {
          const type = spec.field('type');
          const value = spec.field('value');
          const values = value?.namedChildren() ?? [];
          if (isConst && value) {
            lastType = type ? ws(textWithout(type)) : '';
            lastValue = ws(textWithout(value));
          }
          spec.fieldChildren('name').forEach((n, j) => {
            const name = n.text();
            if (name === '_') return;
            const decl: GoDecl = {
              id: `${f.file}#${name}`,
              name,
              kind: isConst ? 'const' : 'variable',
              file: f,
              typeNode: type,
              valueNode: values[j] ?? null,
            };
            const t = type ? ws(textWithout(type)) : isConst ? lastType : '';
            const sig = isConst
              ? `const ${name} ${t}=${lastValue}${/\biota\b/.test(lastValue) ? `@${i}` : ''}`
              : `var ${name} ${t}`;
            add(decl, single ? top : spec, sig.replace(/ +/g, ' ').trim(), isExported(name));
          });
        });
      }
    }
  }

  // ------------------------------------------------------------------ references

  references(id: string): Reference[] {
    const decl = this.declById.get(id);
    if (!decl) return [];
    const pkg = decl.file.pkg;
    const out: Reference[] = [];
    for (const f of this.files.values()) {
      const relevant =
        f.pkg === pkg || [...f.imports.values()].includes(pkg) || f.dots.includes(pkg) || f.file === decl.file.file;
      if (!relevant || !f.text.includes(decl.name)) continue;
      for (const line of this.fileRefs(f).byId.get(id) ?? []) out.push({ file: f.file, line });
    }
    return out;
  }

  private fileRefs(f: GoFile): RefSink {
    let sink = this.refCache.get(f.file);
    if (sink) return sink;
    sink = new RefSink();
    new GoWalker(this, f, sink).walkFile();
    this.refCache.set(f.file, sink);
    return sink;
  }

  /** Package-level name visible in file `f` without qualification. */
  pkgName(name: string, f: GoFile): GoDecl | undefined {
    return f.pkg.decls.get(name) ?? f.dots.map((p) => p.decls.get(name)).find(Boolean);
  }

  uniqueMethod(name: string): GoDecl | undefined {
    const m = this.methodsByName.get(name);
    return m?.length === 1 ? m[0] : undefined;
  }

  /** Method `name` of type decl `t` (incl. promoted through embedded fields / aliases). */
  findMethod(t: GoDecl, name: string, depth = 0): GoDecl | undefined {
    if (depth > 4) return undefined;
    const own = t.file.pkg.methods.get(`${t.name}.${name}`);
    if (own) return own;
    const via = [...(t.embedded ?? []), ...(t.kind === 'type' && t.alias ? [t.alias] : [])];
    for (const e of via) {
      const r = this.resolveType(e, new Scope(), t.file);
      if (r !== 'unknown' && r.decl) {
        const m = this.findMethod(r.decl, name, depth + 1);
        if (m) return m;
      }
    }
    return undefined;
  }

  resolveType(t: SgNode | null | undefined, s: Scope<Local>, f: GoFile): TypeRef {
    if (!t) return 'unknown';
    switch (t.kind()) {
      case 'pointer_type':
      case 'parenthesized_type':
        return this.resolveType(t.namedChildren()[0], s, f);
      case 'generic_type':
        return this.resolveType(t.field('type'), s, f);
      case 'type_identifier':
      case 'identifier': {
        const name = t.text();
        if (s.lookup(name)) return 'unknown';
        const d = this.pkgName(name, f);
        if (d) return TYPE_KINDS.has(d.kind) ? { decl: d } : 'unknown';
        return {}; // predeclared (int, string, error, …)
      }
      case 'qualified_type': {
        const pkgName = t.field('package')?.text() ?? '';
        if (!f.imports.has(pkgName)) return 'unknown';
        const target = f.imports.get(pkgName);
        if (!target) return {};
        const d = target.decls.get(t.field('name')?.text() ?? '');
        return d && TYPE_KINDS.has(d.kind) ? { decl: d } : {};
      }
      default:
        return {}; // map/slice/func/struct literal types: known, not a named indexed type
    }
  }

  /** Type of a value of decl `d` (var/const), or of `d` used as an operand (type name). */
  valueType(d: GoDecl, depth: number): TypeRef {
    if (TYPE_KINDS.has(d.kind)) return { decl: d };
    if (d.kind === 'const') return {};
    if (d.kind === 'variable') {
      if (d.typeNode) return this.resolveType(d.typeNode, new Scope(), d.file);
      if (d.valueNode) return this.typeOf(d.valueNode, new Scope(), d.file, depth + 1);
    }
    return 'unknown';
  }

  /** Result type of calling `d` (func/method), or of converting to `d` (type). */
  callResult(d: GoDecl | undefined, depth: number): TypeRef {
    if (!d) return 'unknown';
    if (TYPE_KINDS.has(d.kind)) return { decl: d };
    if (d.kind !== 'function' && d.kind !== 'method') return 'unknown';
    const r = d.resultNode;
    if (!r) return 'unknown';
    const first = r.kind() === 'parameter_list' ? r.namedChildren()[0]?.field('type') : r;
    return depth > 8 ? 'unknown' : this.resolveType(first, new Scope(), d.file);
  }

  typeOf(e: SgNode | null | undefined, s: Scope<Local>, f: GoFile, depth = 0): TypeRef {
    if (!e || depth > 8) return 'unknown';
    switch (e.kind()) {
      case 'identifier': {
        const name = e.text();
        const l = s.lookup(name);
        if (l) return l.type ?? 'unknown';
        const d = this.pkgName(name, f);
        return d ? this.valueType(d, depth) : 'unknown';
      }
      case 'parenthesized_expression':
        return this.typeOf(e.namedChildren()[0], s, f, depth + 1);
      case 'unary_expression': {
        const op = e.children()[0]?.text();
        return op === '&' || op === '*' ? this.typeOf(e.field('operand'), s, f, depth + 1) : 'unknown';
      }
      case 'composite_literal':
        return this.resolveType(e.field('type'), s, f);
      case 'type_conversion_expression': {
        const t = e.field('type');
        const base = t?.kind() === 'generic_type' ? t.field('type') : t;
        if (base && (base.kind() === 'type_identifier' || base.kind() === 'identifier') && !s.lookup(base.text()))
          return this.callResult(this.pkgName(base.text(), f), depth + 1);
        return this.resolveType(t, s, f);
      }
      case 'call_expression': {
        let fn = e.field('function');
        if (fn?.kind() === 'index_expression' || fn?.kind() === 'generic_type') fn = fn.field('operand') ?? fn;
        if (!fn) return 'unknown';
        if (fn.kind() === 'identifier') {
          const name = fn.text();
          if (s.lookup(name)) return 'unknown';
          if (name === 'new') return this.resolveType(e.field('arguments')?.namedChildren()[0], s, f);
          return this.callResult(this.pkgName(name, f), depth + 1);
        }
        if (fn.kind() === 'selector_expression') {
          const target = this.importTarget(fn.field('operand'), s, f);
          const field = fn.field('field')?.text() ?? '';
          if (target !== undefined) return target ? this.callResult(target.decls.get(field), depth + 1) : {};
          const t = this.typeOf(fn.field('operand'), s, f, depth + 1);
          if (t !== 'unknown' && t.decl) return this.callResult(this.findMethod(t.decl, field), depth + 1);
        }
        return 'unknown';
      }
      case 'selector_expression': {
        const target = this.importTarget(e.field('operand'), s, f);
        if (target === undefined) return 'unknown';
        const d = target?.decls.get(e.field('field')?.text() ?? '');
        return target ? (d ? this.valueType(d, depth) : 'unknown') : {};
      }
      default:
        return 'unknown';
    }
  }

  /**
   * When `op` is an import name (not shadowed): its package (null = outside the
   * index). undefined when `op` is not a package reference.
   */
  importTarget(op: SgNode | null | undefined, s: Scope<Local>, f: GoFile): GoPackage | null | undefined {
    if (!op || (op.kind() !== 'identifier' && op.kind() !== 'package_identifier')) return undefined;
    const name = op.text();
    if (s.lookup(name) || !f.imports.has(name) || f.pkg.decls.has(name)) return undefined;
    return f.imports.get(name);
  }
}

function hasParen(decl: SgNode): boolean {
  return decl.children().some((c) => c.text() === '(');
}

function baseTypeName(t: SgNode): string | undefined {
  const k = t.kind();
  if (k === 'pointer_type' || k === 'parenthesized_type') {
    const inner = t.namedChildren()[0];
    return inner ? baseTypeName(inner) : undefined;
  }
  if (k === 'generic_type') {
    const inner = t.field('type');
    return inner ? baseTypeName(inner) : undefined;
  }
  return k === 'type_identifier' ? t.text() : undefined;
}

const BLOCKS = new Set([
  'block',
  'if_statement',
  'for_statement',
  'expression_switch_statement',
  'select_statement',
  'expression_case',
  'type_case',
  'default_case',
  'communication_case',
]);

class GoWalker {
  constructor(
    private readonly p: GoProvider,
    private readonly f: GoFile,
    private readonly out: RefSink,
  ) {}

  walkFile(): void {
    const s = new Scope<Local>();
    for (const top of this.f.root.namedChildren()) {
      const k = top.kind();
      if (k === 'package_clause' || k === 'import_declaration' || k === 'comment') continue;
      if (k === 'type_declaration') this.typeDecl(top, s, false);
      else if (k === 'const_declaration' || k === 'var_declaration') this.valueDecl(top, s, false);
      else this.walk(top, s);
    }
  }

  private record(d: GoDecl | undefined, at: SgNode): void {
    if (d) this.out.add(d.id, at);
  }

  private typeParams(list: SgNode | null, s: Scope<Local>): void {
    if (!list) return;
    for (const d of list.namedChildren())
      for (const n of d.fieldChildren('name')) s.declare(n.text(), { typeparam: true });
    for (const d of list.namedChildren()) this.walk(d.field('type'), s);
  }

  /** Walk parameter types; declare the names in `s` (after all types). */
  private params(list: SgNode | null | undefined, s: Scope<Local>): void {
    if (!list) return;
    if (list.kind() !== 'parameter_list') return this.walk(list, s);
    const decls: [string, SgNode | null][] = [];
    for (const p of list.namedChildren()) {
      const t = p.field('type');
      this.walk(t, s);
      for (const n of p.fieldChildren('name')) decls.push([n.text(), t]);
    }
    const types = decls.map(([, t]) => this.p.resolveType(t, s, this.f));
    decls.forEach(([n], i) => s.declare(n, { type: types[i] }));
  }

  private typeDecl(n: SgNode, s: Scope<Local>, local: boolean): void {
    for (const spec of n.namedChildren()) {
      if (spec.kind() !== 'type_spec' && spec.kind() !== 'type_alias') continue;
      if (local) s.declare(spec.field('name')?.text() ?? '', { typeparam: true });
      const ts = new Scope<Local>(s);
      this.typeParams(spec.field('type_parameters'), ts);
      this.walk(spec.field('type'), ts);
    }
  }

  private valueDecl(n: SgNode, s: Scope<Local>, local: boolean): void {
    for (const spec of n.findAll({ rule: { any: [{ kind: 'const_spec' }, { kind: 'var_spec' }] } })) {
      const t = spec.field('type');
      const value = spec.field('value');
      this.walk(t, s);
      this.walk(value, s);
      if (!local) continue;
      const values = value?.namedChildren() ?? [];
      const names = spec.fieldChildren('name');
      const types = names.map((_n, j) => {
        const v = values[j];
        return t ? this.p.resolveType(t, s, this.f) : v ? this.p.typeOf(v, s, this.f) : 'unknown';
      });
      names.forEach((nm, j) => s.declare(nm.text(), { type: types[j] }));
    }
  }

  /** Declare `left := right` names; types are inferred before any name is declared. */
  private declareLeft(left: SgNode | null, right: SgNode | null, s: Scope<Local>): void {
    const ids = left?.namedChildren() ?? [];
    const rights = right?.kind() === 'expression_list' ? right.namedChildren() : right ? [right] : [];
    const types = ids.map((_id, i) => {
      const r = rights.length === ids.length ? rights[i] : i === 0 ? rights[0] : undefined;
      return r ? this.p.typeOf(r, s, this.f) : 'unknown';
    });
    ids.forEach((id, i) => id.kind() === 'identifier' && s.declare(id.text(), { type: types[i] }));
  }

  walk(n: SgNode | null | undefined, s: Scope<Local>): void {
    if (!n) return;
    const k = n.kind() as string;
    switch (k) {
      case 'comment':
      case 'field_identifier':
      case 'package_identifier':
      case 'label_name':
      case 'interpreted_string_literal':
      case 'raw_string_literal':
        return;
      case 'function_declaration':
      case 'method_declaration':
      case 'func_literal': {
        const fs = new Scope<Local>(s);
        this.typeParams(n.field('type_parameters'), fs);
        this.params(n.field('receiver'), fs);
        this.params(n.field('parameters'), fs);
        this.params(n.field('result'), fs);
        this.walk(n.field('body'), fs);
        return;
      }
      case 'parameter_list':
        return this.params(n, new Scope(s));
      case 'type_declaration':
        return this.typeDecl(n, s, true);
      case 'const_declaration':
      case 'var_declaration':
        return this.valueDecl(n, s, true);
      case 'short_var_declaration': {
        const right = n.field('right');
        this.walk(right, s);
        return this.declareLeft(n.field('left'), right, s);
      }
      case 'range_clause':
      case 'receive_statement': {
        const right = n.field('right');
        this.walk(right, s);
        if (n.children().some((c) => c.text() === ':=')) this.declareLeft(n.field('left'), null, s);
        else this.walk(n.field('left'), s);
        return;
      }
      case 'type_switch_statement': {
        const ss = new Scope<Local>(s);
        const alias = n.field('alias');
        const value = n.field('value');
        this.walk(value, ss);
        for (const a of alias?.namedChildren() ?? []) ss.declare(a.text(), {});
        for (const c of n.namedChildren()) if (c.id() !== alias?.id() && c.id() !== value?.id()) this.walk(c, ss);
        return;
      }
      case 'selector_expression':
        return this.selector(n, s);
      case 'qualified_type': {
        const target = this.p.importTarget(n.field('package'), s, this.f) ?? undefined;
        const name = n.field('name');
        if (target && name) this.record(target.decls.get(name.text()), name);
        else if (!this.f.imports.has(n.field('package')?.text() ?? '')) this.walk(name, s);
        return;
      }
      case 'identifier':
      case 'type_identifier': {
        const name = n.text();
        if (name === '_' || s.lookup(name)) return;
        return this.record(this.p.pkgName(name, this.f), n);
      }
      case 'keyed_element': {
        const [key, value] = n.namedChildren();
        const keyId = key?.namedChildren().length === 1 ? key.namedChildren()[0] : undefined;
        if (!(keyId?.kind() === 'identifier' && this.keysAreFields(n))) this.walk(key, s);
        this.walk(value, s);
        return;
      }
      default: {
        const inner = BLOCKS.has(k) ? new Scope<Local>(s) : s;
        for (const c of n.namedChildren()) this.walk(c, inner);
      }
    }
  }

  /** In `T{Key: v}`, is Key a struct field name (vs a map key / array index expression)? */
  private keysAreFields(keyed: SgNode): boolean {
    const lit = keyed.parent();
    const owner = lit?.parent();
    if (owner?.kind() === 'composite_literal') {
      const t = owner.field('type')?.kind();
      return !(t === 'map_type' || t === 'slice_type' || t === 'array_type' || t === 'implicit_length_array_type');
    }
    return true; // elided element type: assume struct
  }

  private selector(n: SgNode, s: Scope<Local>): void {
    const op = n.field('operand');
    const field = n.field('field');
    if (!field) return this.walk(op, s);
    const name = field.text();
    const target = this.p.importTarget(op, s, this.f);
    if (target !== undefined) {
      if (target) this.record(target.decls.get(name), field);
      return;
    }
    this.walk(op, s);
    const t = this.p.typeOf(op, s, this.f);
    if (t === 'unknown') {
      const parent = n.parent();
      if (parent?.kind() === 'call_expression' && parent.field('function')?.id() === n.id())
        this.record(this.p.uniqueMethod(name), field);
    } else if (t.decl) this.record(this.p.findMethod(t.decl, name), field);
  }
}
