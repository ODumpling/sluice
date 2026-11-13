/**
 * C# symbols from tree-sitter (no Roslyn / .NET SDK needed).
 *
 * Symbols are type declarations — class, struct, interface, record (class /
 * struct), enum, delegate — in the global namespace or in block / file-scoped
 * namespaces. Ids are `path#<metadata name>`: namespace + enclosing types +
 * generic arity in .NET metadata style, e.g. `Models/Invoice.cs#Acme.Models.Invoice`,
 * `Box.cs#Acme.Box`1`, nested `…#Acme.Outer`1.Inner` (nested types are their
 * own symbols, with `container` = the outer type; types in the global
 * namespace are just `path#Name`). The same names key partial-type merging and
 * reference lookups, so `Box` and `Box<T>`, or `A.Item` and `B.Item` in one
 * file, are distinct symbols. A partial type is ONE symbol keyed by (project,
 * metadata name): its id uses the primary part's file (the file named
 * `<Type>.cs`, else the first by path), `parts` lists every part (primary
 * first), and `symbolsAt` matches any part. Project = nearest directory with a
 * `*.csproj` (else the root).
 *
 * `exported` = visible outside its file: top-level types unless `file`-local
 * (internal types are assembly-wide, so they count), nested types unless
 * private (the default) and their container is exported. The signature covers
 * modifiers, type parameters, base list, constraints and every non-private
 * member's declaration without bodies / initializers (const values are kept;
 * nested types have their own signature).
 *
 * References resolve type names through C# scoping: enclosing types (nested
 * types), the namespace and its parents, `using` / `using static` / alias
 * directives at each level, `global using` anywhere in the project, and
 * fully-qualified / `global::` names. Covered positions: type syntax (fields,
 * params, generics, arrays, nullable, casts, patterns, `typeof`), `new X()`,
 * static access `X.Y`, base lists, constraints, attributes (`[Foo]` →
 * `FooAttribute`), `nameof`, members imported by `using static`, and extension
 * method calls `x.Ext()` when the extension class's namespace is in scope.
 * Simple names shadowed by a local / parameter in expression position and
 * type parameters are not counted. Members reached through an inferred type
 * (`var x = repo.Get(); x.Total`) are not tracked.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseSource } from '@sluice-dev/lang';
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
  type SymbolSpan,
} from './model.js';

interface Usings {
  aliases: Map<string, string>;
  imports: string[];
  statics: string[];
}

interface Level extends Usings {
  /** Namespace of this level ('' = compilation unit / global namespace). */
  ns: string;
}

interface CsFile {
  file: string;
  text: string;
  root: SgNode;
  project: string;
  usings: Usings;
}

interface CsType {
  key: string;
  fqn: string;
  /** Metadata name inside its namespace (`Outer`1.Inner`). */
  path: string;
  name: string;
  ns: string;
  project: string;
  kind: SymbolKind;
  parts: { file: CsFile; node: SgNode }[];
  outer?: CsType;
  /** Static / const member names and enum members (reachable through `using static`). */
  statics: Set<string>;
  /** Extension method names declared in this (static) type. */
  extensions: Set<string>;
  id: string;
}

const TYPE_DECLS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  struct_declaration: 'struct',
  interface_declaration: 'interface',
  record_declaration: 'record',
  record_struct_declaration: 'record',
  enum_declaration: 'enum',
  delegate_declaration: 'delegate',
};

const FUNCTIONS = new Set([
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'local_function_statement',
  'indexer_declaration',
  'accessor_declaration',
  'lambda_expression',
  'anonymous_method_expression',
  'delegate_declaration',
]);

const BLOCKS = new Set([
  'block',
  'switch_section',
  'for_statement',
  'using_statement',
  'fixed_statement',
  'catch_clause',
  'while_statement',
  'do_statement',
  'if_statement',
]);

const TYPE_PARENTS = new Set([
  'base_list',
  'type_argument_list',
  'type_parameter_constraint',
  'nullable_type',
  'array_type',
  'pointer_type',
  'ref_type',
  'scoped_type',
  'tuple_element',
  'typeof_expression',
  'default_expression',
  'sizeof_expression',
]);

const modifiers = (n: SgNode) =>
  n
    .children()
    .filter((c) => c.kind() === 'modifier')
    .map((c) => c.text());

const join2 = (a: string, b: string) => (a ? `${a}.${b}` : b);
const cleanName = (s: string) =>
  s
    .replace(/^global::/, '')
    .replace(/<[^]*>/g, '')
    .replace(/\s+/g, '');

/** Metadata-style name of a (possibly generic) type: `Box`, `Box`1`, `Dict`2`. */
const keyOf = (name: string, arity: number) => (arity ? `${name}\`${arity}` : name);

/** Number of type arguments in a `<…>` list (`<,>` in `typeof(Dict<,>)` counts 2). */
function arityOf(list: SgNode | null | undefined): number {
  if (!list) return 0;
  const named = list.namedChildren().length;
  return named || list.children().filter((c) => c.text() === ',').length + 1;
}

/** Dotted metadata-style name of a name node (`N.Box<int>.Inner` → `N.Box`1.Inner`). */
function keyedName(n: SgNode | null | undefined): string {
  if (!n) return '';
  const k = n.kind() as string;
  if (k === 'qualified_name') return join2(keyedName(n.field('qualifier')), keyedName(n.field('name')));
  if (k === 'alias_qualified_name') return keyedName(n.field('name'));
  if (k === 'generic_name') {
    const id = n.namedChildren().find((c) => c.kind() === 'identifier');
    return keyOf(id?.text() ?? '', arityOf(n.namedChildren().find((c) => c.kind() === 'type_argument_list')));
  }
  return cleanName(n.text());
}

/** Members accessible outside the type (everything but private / default-private). */
function visibleMember(m: SgNode, containerKind: SymbolKind): boolean {
  const mods = modifiers(m);
  if (mods.some((x) => x === 'public' || x === 'protected' || x === 'internal')) return true;
  if (mods.includes('private')) return false;
  if (m.children().some((c) => c.kind() === 'explicit_interface_specifier')) return true;
  return containerKind === 'interface';
}

function memberSignature(m: SgNode): string {
  const k = m.kind() as string;
  if (k === 'field_declaration' || k === 'event_field_declaration') {
    const vd = m.namedChildren().find((c) => c.kind() === 'variable_declaration');
    const isConst = modifiers(m).includes('const');
    const names = (vd?.namedChildren() ?? [])
      .filter((c) => c.kind() === 'variable_declarator')
      .map((d) => (isConst ? textWithout(d) : (d.field('name')?.text() ?? '')));
    const head = textWithout(m, vd ? [vd] : []).replace(/;\s*$/, '');
    return ws(`${head} ${vd?.field('type') ? textWithout(vd.field('type')!) : ''} ${names.join(',')}`);
  }
  // bodies, `=> expr`, property initializers and `: base(…)` are implementation
  const cut: (SgNode | null)[] = [m.field('body'), m.field('value')];
  for (const c of m.children()) if (c.kind() === 'constructor_initializer') cut.push(c);
  for (const a of m.field('accessors')?.namedChildren() ?? []) cut.push(a.field('body'));
  return ws(textWithout(m, cut).replace(/;\s*$/, ''));
}

export class CSharpProvider implements SymbolProvider {
  readonly symbols: SymbolInfo[] = [];
  private readonly files = new Map<string, CsFile>();
  private readonly types = new Map<string, CsType>();
  private readonly byFqn = new Map<string, CsType[]>();
  private readonly byNode = new Map<string, CsType>();
  private readonly byId = new Map<string, CsType>();
  private readonly extensions = new Map<string, CsType[]>();
  private readonly projectUsings = new Map<string, Usings>();
  /** Every name worth resolving (type names, attribute short names, statics, extensions). */
  readonly names = new Set<string>();
  private readonly refCache = new Map<string, RefSink>();
  private readonly projectCache = new Map<string, string>();

  constructor(
    readonly root: string,
    files: string[],
  ) {
    for (const file of files) this.load(file);
    for (const f of this.files.values()) this.collect(f.root.namedChildren(), f, '');
    this.finish();
  }

  // ------------------------------------------------------------------ loading

  private projectOf(dir: string): string {
    const hit = this.projectCache.get(dir);
    if (hit !== undefined) return hit;
    let p = '.';
    try {
      if (readdirSync(join(this.root, dir)).some((n) => n.endsWith('.csproj'))) p = dir;
      else if (dir !== '.' && dir !== '') p = this.projectOf(dirname(dir));
    } catch {
      // unreadable: treat as root project
    }
    this.projectCache.set(dir, p);
    return p;
  }

  private load(file: string): void {
    if (!existsSync(join(this.root, file))) return;
    const text = readFileSync(join(this.root, file), 'utf8');
    const root = parseSource('csharp', text, file).root();
    const project = this.projectOf(dirname(file));
    const f: CsFile = { file, text, root, project, usings: { aliases: new Map(), imports: [], statics: [] } };
    let global = this.projectUsings.get(project);
    if (!global) this.projectUsings.set(project, (global = { aliases: new Map(), imports: [], statics: [] }));
    for (const u of root.namedChildren().filter((c) => c.kind() === 'using_directive')) {
      const isGlobal = u.children().some((c) => !c.isNamed() && c.text() === 'global');
      this.addUsing(u, isGlobal ? global : f.usings);
    }
    this.files.set(file, f);
  }

  private addUsing(u: SgNode, into: Usings): void {
    const alias = u.field('name');
    const target = u.namedChildren().find((c) => c.id() !== alias?.id());
    if (!target) return;
    const name = keyedName(target);
    if (alias) into.aliases.set(alias.text(), name);
    else if (u.children().some((c) => !c.isNamed() && c.text() === 'static')) into.statics.push(name);
    else into.imports.push(name);
  }

  private usingsOf(nodes: SgNode[]): Usings {
    const u: Usings = { aliases: new Map(), imports: [], statics: [] };
    for (const n of nodes) if (n.kind() === 'using_directive') this.addUsing(n, u);
    return u;
  }

  // ------------------------------------------------------------------ symbols

  private collect(nodes: SgNode[], f: CsFile, ns: string, outer?: CsType): void {
    let cur = ns;
    for (const n of nodes) {
      const k = n.kind() as string;
      if (k === 'namespace_declaration') {
        const body = n.field('body');
        if (body) this.collect(body.namedChildren(), f, join2(cur, cleanName(n.field('name')?.text() ?? '')));
      } else if (k === 'file_scoped_namespace_declaration') {
        cur = join2(ns, cleanName(n.field('name')?.text() ?? ''));
        this.collect(
          n.namedChildren().filter((c) => c.id() !== n.field('name')?.id()),
          f,
          cur,
        );
      } else if (TYPE_DECLS[k]) this.addType(n, f, cur, outer);
    }
  }

  private addType(n: SgNode, f: CsFile, ns: string, outer?: CsType): void {
    const name = n.field('name')?.text();
    if (!name) return;
    const tps = n.field('type_parameters') ?? n.namedChildren().find((c) => c.kind() === 'type_parameter_list');
    const own = keyOf(name, tps?.namedChildren().length ?? 0);
    const path = outer ? `${outer.path}.${own}` : own;
    const fqn = join2(ns, path);
    const key = `${f.project}\0${fqn}`;
    let t = this.types.get(key);
    if (!t) {
      t = {
        key,
        fqn,
        path,
        name,
        ns,
        project: f.project,
        kind: TYPE_DECLS[n.kind() as string]!,
        parts: [],
        outer,
        statics: new Set(),
        extensions: new Set(),
        id: '',
      };
      this.types.set(key, t);
      const same = this.byFqn.get(fqn) ?? [];
      same.push(t);
      this.byFqn.set(fqn, same);
    }
    t.parts.push({ file: f, node: n });
    this.byNode.set(`${f.file}:${n.id()}`, t);
    this.names.add(name);
    if (name.endsWith('Attribute') && name.length > 9) this.names.add(name.slice(0, -9));
    const body = n.field('body');
    if (!body) return;
    const isStaticClass = modifiers(n).includes('static');
    for (const m of body.namedChildren()) {
      const mk = m.kind() as string;
      if (TYPE_DECLS[mk]) {
        this.addType(m, f, ns, t);
        continue;
      }
      const mods = modifiers(m);
      const memberNames =
        mk === 'field_declaration'
          ? (m
              .namedChildren()
              .find((c) => c.kind() === 'variable_declaration')
              ?.namedChildren()
              .filter((c) => c.kind() === 'variable_declarator')
              .map((d) => d.field('name')?.text() ?? '') ?? [])
          : [m.field('name')?.text() ?? ''];
      if (mk === 'enum_member_declaration' || mods.includes('static') || mods.includes('const'))
        for (const mn of memberNames) if (mn) t.statics.add(mn);
      if (mk === 'method_declaration' && isStaticClass && mods.includes('static')) {
        const first = m.field('parameters')?.namedChildren()[0];
        if (first?.children().some((c) => c.kind() === 'modifier' && c.text() === 'this')) {
          const mn = m.field('name')?.text();
          if (mn) {
            t.extensions.add(mn);
            this.names.add(mn);
            const list = this.extensions.get(mn) ?? [];
            if (!list.includes(t)) list.push(t);
            this.extensions.set(mn, list);
          }
        }
      }
    }
  }

  private finish(): void {
    for (const t of this.types.values()) {
      // primary part: the file named after the type (`Invoice.cs`), else the first by (ordinal) path
      const rank = (p: { file: CsFile }) => (basename(p.file.file) === `${t.name}.cs` ? 0 : 1);
      t.parts.sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (a.file.file < b.file.file ? -1 : a.file.file > b.file.file ? 1 : 0) ||
          lineOf(a.node) - lineOf(b.node),
      );
      t.id = `${t.parts[0]!.file.file}#${t.fqn}`;
      for (const s of t.statics) this.names.add(s);
    }
    for (const t of this.types.values()) {
      const spans: SymbolSpan[] = t.parts.map((p) => ({
        file: p.file.file,
        startLine: lineOf(p.node),
        endLine: endLineOf(p.node),
      }));
      const info: SymbolInfo = {
        id: t.id,
        name: t.path,
        kind: t.kind,
        exported: this.exported(t),
        ...spans[0]!,
        signature: this.signature(t),
        language: 'csharp',
      };
      if (spans.length > 1) info.parts = spans;
      if (t.outer) info.container = t.outer.id;
      this.symbols.push(info);
      this.byId.set(t.id, t);
    }
  }

  private exported(t: CsType): boolean {
    const mods = new Set(t.parts.flatMap((p) => modifiers(p.node)));
    if (mods.has('file')) return false;
    if (!t.outer) return true;
    if (!this.exported(t.outer)) return false;
    if (['public', 'protected', 'internal'].some((m) => mods.has(m))) return true;
    return !mods.has('private') && t.outer.kind === 'interface';
  }

  private signature(t: CsType): string {
    const mods = [...new Set(t.parts.flatMap((p) => modifiers(p.node)))].filter((m) => m !== 'partial').sort();
    const first = t.parts[0]!.node;
    if (t.kind === 'delegate' || t.kind === 'enum') {
      const attrs = first.children().filter((c) => c.kind() === 'attribute_list' || c.kind() === 'modifier');
      return ws(`${mods.join(' ')} ${textWithout(first, attrs)}`);
    }
    const keyword = first
      .children()
      .filter((c) => !c.isNamed() && /^(class|struct|interface|record)$/.test(c.text()))
      .map((c) => c.text())
      .join(' ');
    const bases = new Set<string>();
    const constraints = new Set<string>();
    const members: string[] = [];
    let typeParams = '';
    let positional = '';
    for (const { node } of t.parts) {
      for (const c of node.namedChildren()) {
        const ck = c.kind() as string;
        if (ck === 'type_parameter_list') typeParams = ws(textWithout(c));
        else if (ck === 'parameter_list') positional = ws(textWithout(c));
        else if (ck === 'base_list') for (const b of c.namedChildren()) bases.add(ws(textWithout(b)));
        else if (ck === 'type_parameter_constraints_clause') constraints.add(ws(textWithout(c)));
      }
      for (const m of node.field('body')?.namedChildren() ?? []) {
        if (TYPE_DECLS[m.kind() as string] || m.kind() === 'comment' || !visibleMember(m, t.kind)) continue;
        members.push(memberSignature(m));
      }
    }
    const baseText = bases.size ? `:${[...bases].sort().join(',')}` : '';
    const where = [...constraints].sort().join(' ');
    return ws(
      `${mods.join(' ')} ${keyword} ${t.name}${typeParams}${positional}${baseText} ${where}{${members.sort().join(';')}}`,
    );
  }

  // ------------------------------------------------------------------ references

  references(id: string): Reference[] {
    const t = this.byId.get(id);
    if (!t) return [];
    const needles = [t.name, ...t.extensions, ...t.statics];
    if (t.name.endsWith('Attribute')) needles.push(t.name.slice(0, -9));
    const viaGlobal = [...this.projectUsings.values()].some(
      (u) => [...u.aliases.values()].includes(t.fqn) || u.statics.includes(t.fqn),
    );
    const out: Reference[] = [];
    for (const f of this.files.values()) {
      if (!viaGlobal && !needles.some((n) => f.text.includes(n))) continue;
      for (const line of this.fileRefs(f).byId.get(id) ?? []) out.push({ file: f.file, line });
    }
    return out;
  }

  private fileRefs(f: CsFile): RefSink {
    let sink = this.refCache.get(f.file);
    if (sink) return sink;
    sink = new RefSink();
    new CsWalker(this, f, sink).walkFile();
    this.refCache.set(f.file, sink);
    return sink;
  }

  typeAt(f: CsFile, n: SgNode): CsType | undefined {
    return this.byNode.get(`${f.file}:${n.id()}`);
  }

  lookup(fqn: string, project: string): CsType | undefined {
    const c = this.byFqn.get(fqn);
    return c?.find((t) => t.project === project) ?? c?.[0];
  }

  extensionTypes(name: string): CsType[] {
    return this.extensions.get(name) ?? [];
  }

  /** Compilation-unit level: file usings + the project's global usings. */
  cuLevel(f: CsFile): Level {
    const g = this.projectUsings.get(f.project);
    return {
      ns: '',
      aliases: new Map([...(g?.aliases ?? []), ...f.usings.aliases]),
      imports: [...f.usings.imports, ...(g?.imports ?? [])],
      statics: [...f.usings.statics, ...(g?.statics ?? [])],
    };
  }

  usingsFor(nodes: SgNode[]): Usings {
    return this.usingsOf(nodes);
  }
}

interface Ctx {
  /** Innermost first; the last is the compilation unit. */
  levels: Level[];
  /** Enclosing types, innermost first. */
  types: CsType[];
  scope: Scope<'local' | 'typeparam'>;
  /** Inside a member body (variable declarators are locals, not fields). */
  fn: boolean;
}

interface Seg {
  name: string;
  /** Metadata-style key (`Box`1` for `Box<int>`). */
  key: string;
  node: SgNode;
}

class CsWalker {
  constructor(
    private readonly p: CSharpProvider,
    private readonly f: CsFile,
    private readonly out: RefSink,
  ) {}

  walkFile(): void {
    const cu = this.p.cuLevel(this.f);
    const ctx: Ctx = { levels: [cu], types: [], scope: new Scope(), fn: false };
    for (const u of this.f.root.namedChildren().filter((c) => c.kind() === 'using_directive')) this.usingRef(u);
    this.walkList(this.f.root.namedChildren(), ctx);
  }

  /** `using static T;` / `using A = T;` reference T. */
  private usingRef(u: SgNode): void {
    const alias = u.field('name');
    const isStatic = u.children().some((c) => !c.isNamed() && c.text() === 'static');
    if (!alias && !isStatic) return;
    const target = u.namedChildren().find((c) => c.id() !== alias?.id());
    const t = target && this.p.lookup(keyedName(target), this.f.project);
    if (t && target) this.out.add(t.id, target);
  }

  private nsLevels(name: string, body: SgNode[], outer: Level[]): Level[] {
    const parts = cleanName(name).split('.');
    const base = outer[0]!.ns;
    const levels: Level[] = [];
    for (let i = 0; i < parts.length; i++) {
      const ns = join2(base, parts.slice(0, i + 1).join('.'));
      const u: Usings =
        i === parts.length - 1 ? this.p.usingsFor(body) : { aliases: new Map(), imports: [], statics: [] };
      levels.unshift({ ns, ...u });
    }
    return [...levels, ...outer];
  }

  private walkList(nodes: SgNode[], ctx: Ctx): void {
    let c = ctx;
    for (const n of nodes) {
      if (n.kind() === 'file_scoped_namespace_declaration') {
        const nameNode = n.field('name');
        const rest = n.namedChildren().filter((x) => x.id() !== nameNode?.id());
        c = { ...c, levels: this.nsLevels(nameNode?.text() ?? '', rest, ctx.levels) };
        for (const u of rest.filter((x) => x.kind() === 'using_directive')) this.usingRef(u);
        this.walkList(rest, c);
      } else this.walk(n, c);
    }
  }

  private record(t: CsType | undefined, at: SgNode): void {
    if (t) this.out.add(t.id, at);
  }

  private declareTypeParams(n: SgNode, s: Scope<'local' | 'typeparam'>): SgNode | undefined {
    const list =
      n.field('type_parameters') ?? n.namedChildren().find((c) => c.kind() === 'type_parameter_list') ?? undefined;
    for (const tp of list?.namedChildren() ?? []) {
      const name =
        tp.field('name')?.text() ??
        tp
          .namedChildren()
          .find((c) => c.kind() === 'identifier')
          ?.text();
      if (name) s.declare(name, 'typeparam');
    }
    return list ?? undefined;
  }

  /** Walk parameter types; declare names in `s` (when given). */
  private params(list: SgNode, ctx: Ctx, declare: boolean): void {
    for (const p of list.namedChildren()) {
      if (p.kind() !== 'parameter') {
        this.walk(p, ctx);
        continue;
      }
      const name = p.field('name');
      for (const c of p.namedChildren()) if (c.id() !== name?.id()) this.walk(c, ctx);
      if (declare && name) ctx.scope.declare(name.text(), 'local');
    }
  }

  walk(n: SgNode | null | undefined, ctx: Ctx): void {
    if (!n) return;
    const k = n.kind() as string;
    switch (k) {
      case 'comment':
      case 'using_directive':
      case 'predefined_type':
      case 'string_literal':
      case 'verbatim_string_literal':
      case 'raw_string_literal':
      case 'name_colon':
      case 'name_equals':
      case 'implicit_type':
        return;
      case 'namespace_declaration': {
        const body = n.field('body');
        const nodes = body?.namedChildren() ?? [];
        return this.walkList(nodes, {
          ...ctx,
          levels: this.nsLevels(n.field('name')?.text() ?? '', nodes, ctx.levels),
        });
      }
      case 'qualified_name':
      case 'member_access_expression':
      case 'generic_name':
      case 'alias_qualified_name':
        return this.chain(n, ctx);
      case 'identifier':
        return this.simple(n, ctx);
      case 'attribute':
        return this.attribute(n, ctx);
      case 'variable_declarator':
      case 'declaration_pattern':
      case 'declaration_expression':
      case 'catch_declaration':
      case 'single_variable_designation': {
        const name = n.field('name') ?? (k === 'single_variable_designation' ? n : null);
        if (k !== 'single_variable_designation')
          for (const c of n.namedChildren()) if (c.id() !== name?.id()) this.walk(c, ctx);
        if (name?.kind() === 'identifier' && (ctx.fn || k !== 'variable_declarator'))
          ctx.scope.declare(name.text(), 'local');
        return;
      }
      case 'foreach_statement': {
        const s: Ctx = { ...ctx, scope: new Scope(ctx.scope) };
        const left = n.field('left');
        for (const c of n.namedChildren())
          if (c.id() !== left?.id() && c.id() !== n.field('body')?.id()) this.walk(c, s);
        for (const id of left?.kind() === 'identifier'
          ? [left]
          : (left?.findAll({ rule: { kind: 'identifier' } }) ?? []))
          s.scope.declare(id.text(), 'local');
        return this.walk(n.field('body'), s);
      }
      case 'assignment_expression':
        if (n.parent()?.kind() === 'initializer_expression' && n.field('left')?.kind() === 'identifier')
          return this.walk(n.field('right'), ctx); // object initializer: `Prop = value`
        break;
    }
    if (TYPE_DECLS[k] && k !== 'delegate_declaration') return this.typeDecl(n, ctx);
    if (FUNCTIONS.has(k)) return this.func(n, ctx);
    const inner = BLOCKS.has(k) ? { ...ctx, scope: new Scope(ctx.scope) } : ctx;
    const kids = n.namedChildren();
    const nameId = kids.some((c) => c.kind() === 'identifier') ? n.field('name')?.id() : undefined;
    for (const c of kids) {
      if (nameId !== undefined && c.id() === nameId) continue; // declaration name
      this.walk(c, inner);
    }
  }

  private typeDecl(n: SgNode, ctx: Ctx): void {
    const t = this.p.typeAt(this.f, n);
    const c: Ctx = { ...ctx, types: t ? [t, ...ctx.types] : ctx.types, scope: new Scope(ctx.scope), fn: false };
    const tps = this.declareTypeParams(n, c.scope);
    const nameId = n.field('name')?.id();
    for (const ch of n.namedChildren()) {
      if (ch.id() === nameId || ch.id() === tps?.id() || ch.kind() === 'modifier') continue;
      if (ch.kind() === 'parameter_list') this.params(ch, c, false);
      else this.walk(ch, c);
    }
  }

  private func(n: SgNode, ctx: Ctx): void {
    const c: Ctx = { ...ctx, scope: new Scope(ctx.scope), fn: true };
    const tps = this.declareTypeParams(n, c.scope);
    const nameId = n.field('name')?.id();
    const params = n.field('parameters');
    if (params?.kind() === 'identifier')
      c.scope.declare(params.text(), 'local'); // `x => …`
    else if (params) this.params(params, c, true);
    for (const ch of n.namedChildren()) {
      if (ch.id() === nameId || ch.id() === tps?.id() || ch.id() === params?.id() || ch.kind() === 'modifier') continue;
      if (ch.kind() === 'parameter_list' || ch.kind() === 'bracketed_parameter_list') this.params(ch, c, true);
      else this.walk(ch, c);
    }
  }

  private isTypeCtx(n: SgNode): boolean {
    const p = n.parent();
    if (!p) return false;
    if (TYPE_PARENTS.has(p.kind() as string)) return true;
    const id = n.id();
    return p.field('type')?.id() === id || p.field('returns')?.id() === id;
  }

  private simple(n: SgNode, ctx: Ctx): void {
    const name = n.text();
    if (!this.p.names.has(name)) return;
    const typeCtx = this.isTypeCtx(n);
    const v = ctx.scope.lookup(name);
    if (v === 'typeparam' || (v && !typeCtx)) return;
    const t = this.resolveSimple(name, ctx);
    if (t) return this.record(t, n);
    if (!typeCtx) this.record(this.staticImport(name, ctx), n);
  }

  /** A type imported by `using static` that has a static member `name`. */
  private staticImport(name: string, ctx: Ctx): CsType | undefined {
    for (const lvl of ctx.levels)
      for (const st of lvl.statics) {
        const t = this.p.lookup(st, this.f.project);
        if (t?.statics.has(name)) return t;
      }
    return undefined;
  }

  private resolveSimple(name: string, ctx: Ctx): CsType | undefined {
    const look = (fqn: string) => this.p.lookup(fqn, this.f.project);
    for (const t of ctx.types) {
      const hit = look(`${t.fqn}.${name}`);
      if (hit) return hit;
    }
    for (const lvl of ctx.levels) {
      const hit = look(join2(lvl.ns, name));
      if (hit) return hit;
      const alias = lvl.aliases.get(name);
      if (alias) return look(alias);
      for (const imp of lvl.imports) {
        const h = look(join2(imp, name));
        if (h) return h;
      }
      for (const st of lvl.statics) {
        const h = look(join2(st, name));
        if (h) return h;
      }
    }
    return undefined;
  }

  /** Resolve a dotted name; returns the types found (with their segment) and the first unresolved index. */
  private resolveQualified(segs: string[], ctx: Ctx, global = false): { found: [number, CsType][]; next: number } {
    const look = (fqn: string) => this.p.lookup(fqn, this.f.project);
    const found: [number, CsType][] = [];
    let t: CsType | undefined;
    let i = 0;
    let prefixes = global ? [''] : [...new Set([...ctx.levels.map((l) => l.ns), ''])];
    let path = segs;
    if (!global) {
      const alias = ctx.levels.map((l) => l.aliases.get(segs[0]!)).find(Boolean);
      if (alias) {
        t = look(alias);
        if (t) {
          found.push([0, t]);
          i = 1;
        } else {
          // namespace alias: continue from the aliased namespace
          path = [...alias.split('.'), ...segs.slice(1)];
          prefixes = [''];
        }
      } else {
        t = this.resolveSimple(segs[0]!, ctx);
        if (t) {
          found.push([0, t]);
          i = 1;
        }
      }
    }
    const offset = path.length - segs.length; // extra leading segments from a namespace alias
    if (!t) {
      outer: for (let k = 0; k < path.length; k++) {
        const P = path.slice(0, k + 1).join('.');
        for (const pre of prefixes) {
          const hit = look(join2(pre, P));
          if (hit) {
            t = hit;
            found.push([Math.max(0, k - offset), hit]);
            i = k + 1 - offset;
            break outer;
          }
        }
      }
    }
    while (t && i < segs.length) {
      const nt = look(`${t.fqn}.${segs[i]}`);
      if (!nt) break;
      found.push([i, nt]);
      t = nt;
      i++;
    }
    return { found, next: t ? i : 0 };
  }

  private chain(n: SgNode, ctx: Ctx): void {
    const segs: Seg[] = [];
    const typeArgs: SgNode[] = [];
    let base: SgNode | undefined;
    let global = false;
    const push = (x: SgNode | null) => {
      if (!x) return;
      if (x.kind() === 'generic_name') {
        const id = x.namedChildren().find((c) => c.kind() === 'identifier');
        const ta = x.namedChildren().find((c) => c.kind() === 'type_argument_list');
        if (id) segs.push({ name: id.text(), key: keyOf(id.text(), arityOf(ta)), node: id });
        if (ta) typeArgs.push(ta);
      } else if (x.kind() === 'identifier') segs.push({ name: x.text(), key: x.text(), node: x });
    };
    const flat = (x: SgNode | null) => {
      if (!x) return;
      const k = x.kind() as string;
      if (k === 'member_access_expression') {
        flat(x.field('expression'));
        push(x.field('name'));
      } else if (k === 'qualified_name') {
        flat(x.field('qualifier'));
        push(x.field('name'));
      } else if (k === 'alias_qualified_name') {
        global = x.field('alias')?.text() === 'global' || /^global\s*::/.test(x.text());
        push(x.field('name'));
      } else if (k === 'identifier' || k === 'generic_name') push(x);
      else base = x;
    };
    flat(n);
    for (const ta of typeArgs) this.walk(ta, ctx);
    let firstMember = 1;
    if (base) {
      this.walk(base, ctx);
      firstMember = 0;
    } else if (segs.length) {
      const typeCtx = this.isTypeCtx(n);
      const v = ctx.scope.lookup(segs[0]!.name);
      if (v === 'typeparam' || (v && !typeCtx)) firstMember = 1;
      else {
        const { found, next } = this.resolveQualified(
          segs.map((s) => s.key),
          ctx,
          global,
        );
        for (const [i, t] of found) this.record(t, segs[i]!.node);
        if (found.length) firstMember = next;
        else if (!typeCtx) this.record(this.staticImport(segs[0]!.name, ctx), segs[0]!.node);
      }
    }
    if (n.kind() !== 'member_access_expression') return;
    for (const s of segs.slice(firstMember)) this.extension(s, ctx);
  }

  /** `x.Ext()` where Ext is an extension method of a static class whose namespace is in scope. */
  private extension(s: Seg, ctx: Ctx): void {
    for (const t of this.p.extensionTypes(s.name)) {
      const visible = t.ns === '' || ctx.levels.some((l) => l.ns === t.ns || l.imports.includes(t.ns));
      if (visible) this.record(t, s.node);
    }
  }

  private attribute(n: SgNode, ctx: Ctx): void {
    const nameNode = n.field('name');
    for (const c of n.namedChildren()) if (c.id() !== nameNode?.id()) this.walk(c, ctx);
    if (!nameNode) return;
    const nodes =
      nameNode.kind() === 'qualified_name'
        ? nameNode.findAll({ rule: { kind: 'identifier' } })
        : nameNode.kind() === 'identifier'
          ? [nameNode]
          : [];
    const segs = nodes.map((x) => x.text());
    if (!segs.length) return;
    const tryResolve = (names: string[]) => {
      const r = this.resolveQualified(names, ctx);
      return r.next === names.length ? r.found : [];
    };
    let found = tryResolve([...segs.slice(0, -1), segs.at(-1)! + 'Attribute']);
    if (!found.length) found = tryResolve(segs);
    for (const [i, t] of found) this.record(t, nodes[i]!);
  }
}
