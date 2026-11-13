/**
 * Mutation proof: deliberately break the code the change touched and show the
 * approved checks notice. Mutants are generated only on lines the PR changed:
 * JS/TS with the TypeScript compiler API, Go and C# on tree-sitter (via
 * `@sluice-dev/lang`). Go/C# mutants are built to compile (syntactic type
 * hints only); one that still fails to compile is reported `invalid` by
 * the gate and does not count either way.
 */
import { EXTENSIONS, languageOf, parseSource } from '@sluice-dev/lang';
import ts from 'typescript';

export { changedLines, type LineRanges } from '@sluice-dev/sandbox';

export interface Mutant {
  id: string;
  /** Path relative to the repository root. */
  file: string;
  line: number;
  operator: string;
  original: string;
  replacement: string;
  start: number;
  end: number;
}

const BINARY_SWAPS: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: '!==',
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: '===',
  [ts.SyntaxKind.EqualsEqualsToken]: '!=',
  [ts.SyntaxKind.ExclamationEqualsToken]: '==',
  [ts.SyntaxKind.LessThanToken]: '<=',
  [ts.SyntaxKind.LessThanEqualsToken]: '<',
  [ts.SyntaxKind.GreaterThanToken]: '>=',
  [ts.SyntaxKind.GreaterThanEqualsToken]: '>',
  [ts.SyntaxKind.AmpersandAmpersandToken]: '||',
  [ts.SyntaxKind.BarBarToken]: '&&',
  [ts.SyntaxKind.PlusToken]: '-',
  [ts.SyntaxKind.MinusToken]: '+',
  [ts.SyntaxKind.AsteriskToken]: '/',
  [ts.SyntaxKind.SlashToken]: '*',
};

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts')) return ts.ScriptKind.TS;
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/** @deprecated use `languageOf` from `@sluice-dev/lang`; every source language is mutable. */
export const MUTABLE_EXTENSIONS: string[] = Object.values(EXTENSIONS).flat();

function inImportOrKey(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'require') return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  return false;
}

/** All mutants of `text` whose node starts on a changed line. */
export function generateMutants(file: string, text: string, ranges: [number, number][]): Mutant[] {
  const lang = languageOf(file);
  const out =
    lang === 'go' || lang === 'csharp' ? treeSitterMutants(lang, file, text, ranges) : tsMutants(file, text, ranges);
  return out
    .sort((a, b) => a.start - b.start || a.operator.localeCompare(b.operator))
    .map((m, i) => ({ ...m, id: `${file}:${m.line}:${m.operator}:${i}` }));
}

function tsMutants(file: string, text: string, ranges: [number, number][]): Omit<Mutant, 'id'>[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const changed = (n: ts.Node) => {
    const l = line(n.getStart(sf));
    return ranges.some(([a, b]) => l >= a && l <= b);
  };
  const out: Omit<Mutant, 'id'>[] = [];
  const add = (operator: string, start: number, end: number, replacement: string) => {
    out.push({ file, line: line(start), operator, original: text.slice(start, end), replacement, start, end });
  };
  const visit = (node: ts.Node) => {
    if (changed(node)) {
      if (ts.isBinaryExpression(node)) {
        const swap = BINARY_SWAPS[node.operatorToken.kind];
        if (swap) add('binary-operator', node.operatorToken.getStart(sf), node.operatorToken.getEnd(), swap);
      } else if (node.kind === ts.SyntaxKind.TrueKeyword) {
        add('boolean-literal', node.getStart(sf), node.getEnd(), 'false');
      } else if (node.kind === ts.SyntaxKind.FalseKeyword) {
        add('boolean-literal', node.getStart(sf), node.getEnd(), 'true');
      } else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
        add('remove-negation', node.getStart(sf), node.operand.getStart(sf), '');
      } else if (ts.isStringLiteral(node) && node.text.length > 0 && node.text.length <= 40 && !inImportOrKey(node)) {
        add('string-literal', node.getStart(sf), node.getEnd(), "''");
      } else if (ts.isNumericLiteral(node)) {
        add('numeric-literal', node.getStart(sf), node.getEnd(), String(Number(node.text) + 1));
      } else if (ts.isIfStatement(node)) {
        add(
          'negate-condition',
          node.expression.getStart(sf),
          node.expression.getEnd(),
          `!(${node.expression.getText(sf)})`,
        );
      } else if (
        ts.isExpressionStatement(node) &&
        (ts.isAwaitExpression(node.expression) || ts.isCallExpression(node.expression))
      ) {
        add('remove-call', node.getStart(sf), node.getEnd(), 'void 0;');
      } else if (ts.isReturnStatement(node) && node.expression) {
        add('return-value', node.expression.getStart(sf), node.expression.getEnd(), 'undefined');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------- Go / C# (tree-sitter)
//
// Same operators as JS/TS. Both languages are statically typed, so every
// operator only fires where the mutant should still compile, judged from
// syntax alone (no type checker): `+` is not swapped on string-looking
// operands, `return` gets the zero value of the declared result type, removed
// calls keep their identifiers referenced (Go rejects unused variables and
// imports), duplicate `case` labels and sized-int overflows are avoided.

type Node = ReturnType<ReturnType<typeof parseSource>['root']>;
type Emit = (operator: string, start: number, end: number, replacement: string) => void;

const SWAPS: Record<string, string> = {
  '==': '!=',
  '!=': '==',
  '<': '<=',
  '<=': '<',
  '>': '>=',
  '>=': '>',
  '&&': '||',
  '||': '&&',
  '+': '-',
  '-': '+',
  '*': '/',
  '/': '*',
};

const GENERATED = /^\s*\/\/.*(Code generated .* DO NOT EDIT\.|<auto-generated)/m;

/** Named children without comments. */
const named = (n: Node | null | undefined): Node[] =>
  n ? n.namedChildren().filter((c) => c.kind() !== 'comment') : [];
const start = (n: Node) => n.range().start.index;
const end = (n: Node) => n.range().end.index;
const ZERO_LITERAL = /^0+(\.0*)?[uUlLfFdDmM]*$/;
/** String literal content without delimiters (approximate for escapes). */
const strContent = (t: string) => t.replace(/^[$@]*("+|`)/, '').replace(/("+|`)(u8)?$/i, '');

function treeSitterMutants(
  lang: 'go' | 'csharp',
  file: string,
  text: string,
  ranges: [number, number][],
): Omit<Mutant, 'id'>[] {
  if (GENERATED.test(text.slice(0, 2000))) return [];
  const root = parseSource(lang, text, file).root();
  const out: Omit<Mutant, 'id'>[] = [];
  // line of a UTF-16 offset (ast-grep reports UTF-16 indices)
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const emit: Emit = (operator, s, e, replacement) => {
    const original = text.slice(s, e);
    if (original !== replacement)
      out.push({ file, line: lineOf(s), operator, original, replacement, start: s, end: e });
  };
  const changed = (n: Node) => {
    const l = n.range().start.line + 1;
    return ranges.some(([a, b]) => l >= a && l <= b);
  };
  const mutate = lang === 'go' ? goMutate : csMutate;
  const skip = lang === 'go' ? GO_SKIP : CS_SKIP;
  const visit = (n: Node) => {
    if (skip.has(n.kind())) return;
    if (changed(n)) mutate(n, emit, root);
    for (const c of n.namedChildren()) visit(c);
  };
  visit(root);
  return out;
}

/** Subtrees never mutated (import paths, attribute metadata, directives). */
const GO_SKIP = new Set<unknown>(['import_declaration', 'package_clause', 'comment']);
const CS_SKIP = new Set<unknown>([
  'attribute_list',
  'using_directive',
  'extern_alias_directive',
  'comment',
  'preproc_pragma',
  'preproc_region',
  'preproc_endregion',
  'preproc_define',
  'preproc_undef',
  'preproc_line',
  'preproc_error',
  'preproc_warning',
  'preproc_nullable',
]);

function binaryOperator(n: Node, emit: Emit, stringish: (n: Node) => boolean, extraSkip?: (op: string) => boolean) {
  const op = n.field('operator' as never) as Node | null;
  const swap = op && SWAPS[op.text()];
  if (!op || !swap) return;
  const left = n.field('left' as never) as Node | null;
  const right = n.field('right' as never) as Node | null;
  if (!left || !right) return;
  // string concatenation has no `-`
  if (op.text() === '+' && (stringish(left) || stringish(right))) return;
  // `x * 0` → `x / 0` is a constant division by zero (compile error)
  if (op.text() === '*' && ZERO_LITERAL.test(right.text())) return;
  if (extraSkip?.(op.text())) return;
  emit('binary-operator', start(op), end(op), swap);
}

/** Bump an integer literal (keeps C# suffixes); undefined when unsafe. */
function bumpInt(text: string, go: boolean, negated: boolean): string | undefined {
  const m = /^(0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*)([uUlL]*)$/.exec(text);
  if (!m || (go && m[2])) return undefined;
  let digits = m[1]!.replace(/_/g, '');
  if (go && /^0[0-7]+$/.test(digits)) digits = '0o' + digits.slice(1); // legacy octal
  let v: bigint;
  try {
    v = BigInt(digits);
  } catch {
    return undefined;
  }
  const pow2 = (x: bigint) => x >= 128n && (x & (x - 1n)) === 0n;
  // 127/255/MaxInt32… + 1 (or -128 - 1) overflows a sized integer type
  if (pow2(v + 1n) || (negated && pow2(v))) return undefined;
  return (v + 1n).toString() + m[2];
}

/** Bump a plain decimal float literal (`2.5`, `1.0`, C# `2.5m`/`1f`). */
function bumpFloat(text: string, go: boolean): string | undefined {
  const m = /^([\d_]*\.?[\d_]*)([fFdDmM]?)$/.exec(text);
  if (!m || (go && m[2])) return undefined;
  const num = m[1]!.replace(/_/g, '');
  if (!/\d/.test(num)) return undefined;
  const n = Number(num) + 1;
  let s = String(n);
  if (!Number.isFinite(n) || /e/i.test(s)) return undefined;
  if (num.includes('.') && !s.includes('.')) s += '.0';
  return s + m[2];
}

/** Canonical value of a literal node, to detect duplicate `case` labels. */
function literalKey(n: Node): string {
  const k = String(n.kind());
  if (k.includes('string')) return `S${strContent(n.text())}`;
  if (k === 'int_literal' || k === 'integer_literal') {
    try {
      const d = n.text().replace(/[_uUlL]/g, '');
      return `I${BigInt(/^0[0-7]+$/.test(d) ? '0o' + d.slice(1) : d)}`;
    } catch {
      return n.text();
    }
  }
  return n.text();
}

/** The switch whose case label is exactly literal `n` (Go expression_case / C# constant_pattern). */
function caseSwitch(n: Node): Node | undefined {
  const p = n.parent();
  if (!p) return undefined;
  if (p.kind() === 'expression_list' && p.parent()?.kind() === 'expression_case')
    return p.parent()!.parent() ?? undefined;
  if (p.kind() === 'constant_pattern')
    return p.ancestors().find((a) => a.kind() === 'switch_body' || a.kind() === 'switch_expression');
  return undefined;
}

/** Replacing case literal `n` with a value whose key is `key` would duplicate another case. */
function duplicatesCase(n: Node, key: string): boolean {
  const sw = caseSwitch(n);
  if (!sw) return false;
  const labels =
    sw.kind() === 'expression_switch_statement'
      ? sw
          .findAll({ rule: { kind: 'expression_case' } })
          .flatMap((c) => named(c.field('value' as never) as Node | null))
      : sw.findAll({ rule: { kind: 'constant_pattern' } }).flatMap((c) => named(c));
  return labels.some((l) => l.range().start.index !== start(n) && literalKey(l) === key);
}

function emitLiteral(n: Node, emit: Emit, operator: string, replacement: string, key: string) {
  if (!duplicatesCase(n, key)) emit(operator, start(n), end(n), replacement);
}

// ------------------------------------------------ Go

const GO_FUNCS = new Set<unknown>(['function_declaration', 'method_declaration', 'func_literal']);
const GO_NUMERIC = new Set(
  'int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr byte rune float32 float64 complex64 complex128'.split(
    ' ',
  ),
);
const GO_NIL_TYPES = new Set<unknown>([
  'pointer_type',
  'slice_type',
  'map_type',
  'channel_type',
  'function_type',
  'interface_type',
]);
const GO_STRING_FN =
  /^(string|fmt\.Sprint(f|ln)?|strings\.(Join|Repeat|Replace(All)?|Trim\w*|To(Upper|Lower|Title)\w*|Title|Map)|strconv\.(Itoa|Quote\w*|Format\w*)|filepath\.(Join|Base|Dir|Ext|Clean)|path\.(Join|Base|Dir|Ext|Clean)|.+\.(String|Error))$/;

function goMutate(n: Node, emit: Emit, root: Node): void {
  switch (n.kind()) {
    case 'binary_expression':
      return binaryOperator(n, emit, (x) => goStringish(x, root, 0));
    case 'true':
    case 'false': {
      const r = n.kind() === 'true' ? 'false' : 'true';
      return emitLiteral(n, emit, 'boolean-literal', r, r);
    }
    case 'unary_expression': {
      const operand = n.field('operand' as never) as Node | null;
      if ((n.field('operator' as never) as Node | null)?.text() === '!' && operand)
        emit('remove-negation', start(n), start(operand), '');
      return;
    }
    case 'interpreted_string_literal':
    case 'raw_string_literal': {
      const len = strContent(n.text()).length;
      if (len === 0 || len > 40 || goKeyOrTag(n)) return;
      return emitLiteral(n, emit, 'string-literal', '""', 'S');
    }
    case 'int_literal':
    case 'float_literal': {
      if (goKeyOrTag(n)) return;
      const p = n.parent();
      // array lengths / constant indexes: a bump can change the type or go out of range at compile time
      if (p?.kind() === 'array_type' || p?.kind() === 'slice_expression') return;
      if (
        p?.kind() === 'index_expression' &&
        (p.field('index' as never) as Node | null)?.range().start.index === start(n)
      )
        return;
      const negated = p?.kind() === 'unary_expression' && p.child(0)?.text() === '-';
      const r = n.kind() === 'int_literal' ? bumpInt(n.text(), true, negated) : bumpFloat(n.text(), true);
      if (r !== undefined) emitLiteral(n, emit, 'numeric-literal', r, `I${r}`);
      return;
    }
    case 'if_statement': {
      const c = n.field('condition' as never) as Node | null;
      if (c) emit('negate-condition', start(c), end(c), `!(${c.text()})`);
      return;
    }
    case 'expression_statement': {
      const call = named(n)[0];
      if (call?.kind() !== 'call_expression' || n.parent()?.kind() !== 'statement_list') return;
      // a trailing panic() is a terminating statement; without it the func may lack a return
      const fn = (call.field('function' as never) as Node | null)?.text();
      if (fn === 'panic' && !named(n.parent()!).some((s) => start(s) > start(n))) return;
      // keep the call's identifiers referenced: Go rejects unused variables/imports
      emit('remove-call', start(n), end(n), `if false { ${n.text()} }`);
      return;
    }
    case 'return_statement': {
      const exprs = named(named(n).find((c) => c.kind() === 'expression_list'));
      const fn = n.ancestors().find((a) => GO_FUNCS.has(a.kind()));
      if (!exprs.length || !fn) return;
      const types = goResultTypes(fn);
      if (!types || types.length !== exprs.length) return;
      const zero = goZero(types[0]!, fn, root, 0);
      if (zero !== undefined && !goDropsLastUse(exprs[0]!, fn, root))
        emit('return-value', start(exprs[0]!), end(exprs[0]!), zero);
      return;
    }
  }
}

const sameRange = (a: Node | null | undefined, b: Node) => !!a && start(a) === start(b) && end(a) === end(b);

/** `i` is the target of `x := …`, `x = …`, `var x …`, `for x := range`, `switch x := v.(type)` (Go: not a use). */
function goIsDeclOrAssign(i: Node): boolean {
  const p = i.parent();
  if (!p) return false;
  if (p.kind() === 'var_spec' || p.kind() === 'const_spec') return true;
  const gp = p.parent();
  if (p.kind() !== 'expression_list' || !gp) return false;
  if (gp.kind() === 'type_switch_statement') return true;
  if (gp.kind() === 'range_clause') return sameRange(gp.field('left' as never) as Node | null, p);
  if (gp.kind() === 'short_var_declaration' || gp.kind() === 'assignment_statement')
    return sameRange(gp.field('left' as never) as Node | null, p);
  return false;
}

/** Package names imported by a Go file (alias, else last path element). */
function goImportNames(root: Node): Set<string> {
  const out = new Set<string>();
  for (const spec of root.findAll({ rule: { kind: 'import_spec' } })) {
    const alias = (spec.field('name' as never) as Node | null)?.text();
    if (alias) {
      if (alias !== '_' && alias !== '.') out.add(alias);
      continue;
    }
    const segs = strContent((spec.field('path' as never) as Node | null)?.text() ?? '').split('/');
    let last = segs.at(-1) ?? '';
    if (/^v\d+$/.test(last) && segs.length > 1) last = segs.at(-2)!;
    last = last.replace(/\.v\d+$/, '');
    out.add(last);
    out.add(last.replace(/^go-/, '').replace(/-go$/, '').replace(/-/g, ''));
  }
  return out;
}

/**
 * Replacing `expr` would remove the last use of a local variable or an import
 * (Go compile errors: "declared and not used" / "imported and not used").
 */
function goDropsLastUse(expr: Node, fn: Node, root: Node): boolean {
  const inExpr = (n: Node) => start(n) >= start(expr) && end(n) <= end(expr);
  const idRule = { rule: { any: [{ kind: 'identifier' }, { kind: 'package_identifier' }] } };
  const names = new Set(
    [expr, ...expr.findAll(idRule)].filter((i) => String(i.kind()).endsWith('identifier')).map((i) => i.text()),
  );
  const imports = goImportNames(root);
  for (const name of names) {
    if (imports.has(name)) {
      const uses = root
        .findAll(idRule)
        .filter((i) => i.text() === name && !inExpr(i) && !i.inside({ rule: { kind: 'import_declaration' } }));
      if (uses.length === 0) return true;
      continue;
    }
    const occ = fn.findAll({ rule: { kind: 'identifier' } }).filter((i) => i.text() === name && !inExpr(i));
    if (occ.some(goIsDeclOrAssign) && occ.every(goIsDeclOrAssign)) return true;
  }
  return false;
}

/** Struct tag, or key of a keyed composite-literal element (map keys must stay unique). */
function goKeyOrTag(n: Node): boolean {
  const p = n.parent();
  if (!p) return false;
  if (p.kind() === 'field_declaration') return true;
  const kv = p.parent();
  return (
    p.kind() === 'literal_element' && kv?.kind() === 'keyed_element' && named(kv)[0]?.range().start.index === start(p)
  );
}

function goResultTypes(fn: Node): Node[] | undefined {
  const r = fn.field('result' as never) as Node | null;
  if (!r) return [];
  if (r.kind() !== 'parameter_list') return [r];
  const out: Node[] = [];
  for (const p of named(r)) {
    const t = p.field('type' as never) as Node | null;
    if (p.kind() !== 'parameter_declaration' || !t) return undefined;
    const names = Math.max(1, p.fieldChildren('name' as never).length);
    for (let i = 0; i < names; i++) out.push(t);
  }
  return out;
}

/** Zero value of a Go type when it is syntactically obvious. */
function goZero(t: Node, fn: Node, root: Node, depth: number): string | undefined {
  if (depth > 4) return undefined;
  const k = String(t.kind());
  if (GO_NIL_TYPES.has(k)) return 'nil';
  if (k === 'parenthesized_type') {
    const inner = named(t)[0];
    return inner && goZero(inner, fn, root, depth + 1);
  }
  if (k === 'qualified_type') return t.text() === 'time.Duration' ? '0' : undefined;
  if (k !== 'type_identifier') return undefined;
  const name = t.text();
  if (GO_NUMERIC.has(name)) return '0';
  if (name === 'string') return '""';
  if (name === 'bool') return 'false';
  if (name === 'error' || name === 'any') return 'nil';
  const tparams = fn.field('type_parameters' as never) as Node | null;
  if (tparams?.findAll({ rule: { kind: 'identifier' } }).some((i) => i.text() === name)) return undefined;
  // a named type declared in this file
  const spec = root
    .findAll({ rule: { any: [{ kind: 'type_spec' }, { kind: 'type_alias' }] } })
    .find((s) => (s.field('name' as never) as Node | null)?.text() === name && !s.field('type_parameters' as never));
  const u = spec?.field('type' as never) as Node | null | undefined;
  if (!u) return undefined;
  if (u.kind() === 'struct_type') return `${name}{}`;
  return goZero(u, fn, root, depth + 1);
}

/** Expression that is (syntactically) a Go string. */
function goStringish(n: Node | null, root: Node, depth: number): boolean {
  if (!n || depth > 4) return false;
  switch (n.kind()) {
    case 'interpreted_string_literal':
    case 'raw_string_literal':
      return true;
    case 'parenthesized_expression':
      return named(n).some((c) => goStringish(c, root, depth + 1));
    case 'binary_expression':
      return (
        (n.field('operator' as never) as Node | null)?.text() === '+' &&
        (goStringish(n.field('left' as never), root, depth + 1) ||
          goStringish(n.field('right' as never), root, depth + 1))
      );
    case 'call_expression':
      return GO_STRING_FN.test((n.field('function' as never) as Node | null)?.text() ?? '');
    case 'slice_expression':
      return goStringish(n.field('operand' as never), root, depth + 1);
    case 'selector_expression': {
      // a struct field declared `string` in this file
      const f = (n.field('field' as never) as Node | null)?.text();
      return root
        .findAll({ rule: { kind: 'field_declaration' } })
        .some(
          (d) =>
            d.fieldChildren('name' as never).some((x) => (x as Node).text() === f) &&
            (d.field('type' as never) as Node | null)?.text() === 'string',
        );
    }
    case 'identifier':
      return goIdentIsString(n, root, depth);
  }
  return false;
}

function goIdentIsString(id: Node, root: Node, depth: number): boolean {
  const name = id.text();
  const fn = id.ancestors().find((a) => GO_FUNCS.has(a.kind()));
  const names = (n: Node) => n.fieldChildren('name' as never).map((x) => (x as Node).text());
  for (const p of fn?.findAll({ rule: { kind: 'parameter_declaration' } }) ?? [])
    if (names(p).includes(name)) return (p.field('type' as never) as Node | null)?.text() === 'string';
  for (const scope of fn ? [fn, root] : [root]) {
    for (const s of scope.findAll({ rule: { any: [{ kind: 'var_spec' }, { kind: 'const_spec' }] } })) {
      const i = names(s).indexOf(name);
      if (i < 0) continue;
      const t = s.field('type' as never) as Node | null;
      if (t) return t.text() === 'string';
      const v = named(s.field('value' as never) as Node | null)[i];
      if (v) return goStringish(v, root, depth + 1);
    }
  }
  for (const s of fn?.findAll({ rule: { kind: 'short_var_declaration' } }) ?? []) {
    const left = named(s.field('left' as never) as Node | null).map((x) => x.text());
    const right = named(s.field('right' as never) as Node | null);
    const i = left.indexOf(name);
    if (i >= 0 && right.length === left.length && goStringish(right[i]!, root, depth + 1)) return true;
  }
  return false;
}

// ------------------------------------------------ C#

const CS_STRING = new Set<unknown>([
  'string_literal',
  'verbatim_string_literal',
  'raw_string_literal',
  'interpolated_string_expression',
]);
const CS_FUNCS = new Set<unknown>([
  'method_declaration',
  'local_function_statement',
  'accessor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'lambda_expression',
  'anonymous_method_expression',
]);
const CS_STRING_CALL =
  /(^|\.)(ToString|Substring|Trim\w*|ToUpper\w*|ToLower\w*|Replace|PadLeft|PadRight|Insert|Normalize)$|^(nameof|string\.\w+|String\.\w+)$/;
/** `DateTime - DateTime` has no `+`. */
const CS_DATES = /\b(DateTime(Offset)?|DateOnly|TimeOnly)\b|\.(UtcNow|Now|Today)\b/;
const CS_DESIGNATIONS = ['declaration_expression', 'declaration_pattern', 'var_pattern'];

function csMutate(n: Node, emit: Emit, root: Node): void {
  const k = String(n.kind());
  if (CS_STRING.has(k)) {
    const t = n.text();
    const len = strContent(t).length;
    if (len === 0 || len > 40 || /u8$/i.test(t) || csKey(n) || String(n.parent()?.kind()).startsWith('interpolat'))
      return;
    return emitLiteral(n, emit, 'string-literal', '""', 'S');
  }
  switch (k) {
    case 'binary_expression':
      return binaryOperator(
        n,
        emit,
        (x) => csStringish(x, root, 0),
        (op) => (op === '-' && CS_DATES.test(n.text())) || ((op === '&&' || op === '||') && csDeclaresVariables(n)),
      );
    case 'boolean_literal': {
      if (String(n.parent()?.kind()).startsWith('preproc')) return;
      const r = n.text() === 'true' ? 'false' : 'true';
      return emitLiteral(n, emit, 'boolean-literal', r, r);
    }
    case 'prefix_unary_expression': {
      const operand = named(n).at(-1);
      if (n.child(0)?.text() === '!' && operand) emit('remove-negation', start(n), start(operand), '');
      return;
    }
    case 'integer_literal':
    case 'real_literal': {
      if (csKey(n)) return;
      const p = n.parent();
      const negated = p?.kind() === 'prefix_unary_expression' && p.child(0)?.text() === '-';
      const r = k === 'integer_literal' ? bumpInt(n.text(), false, negated) : bumpFloat(n.text(), false);
      if (r !== undefined) emitLiteral(n, emit, 'numeric-literal', r, `I${r.replace(/[uUlL]+$/, '')}`);
      return;
    }
    case 'if_statement': {
      const c = n.field('condition' as never) as Node | null;
      if (c && !csDeclaresVariables(c)) emit('negate-condition', start(c), end(c), `!(${c.text()})`);
      return;
    }
    case 'expression_statement': {
      const e = named(n)[0];
      if (e?.kind() !== 'invocation_expression' && e?.kind() !== 'await_expression') return;
      // an `out` argument assigns a variable that later code may read
      if (n.findAll({ rule: { kind: 'argument' } }).some((a) => a.child(0)?.text() === 'out')) return;
      if (csUsesLambdaParameter(n)) return;
      const p = n.parent()?.kind();
      emit('remove-call', start(n), end(n), p === 'block' || p === 'switch_section' ? ';' : '{ }');
      return;
    }
    case 'return_statement': {
      const e = named(n)[0];
      const fn = n.ancestors().find((a) => CS_FUNCS.has(a.kind()));
      // lambdas may infer their return type from the returned value
      if (!e || !fn || fn.kind() === 'lambda_expression' || fn.kind() === 'anonymous_method_expression') return;
      if (e.kind() === 'ref_expression' || /^(default|null)!?$/.test(e.text())) return;
      emit('return-value', start(e), end(e), 'default!');
      return;
    }
    case 'arrow_expression_clause': {
      const e = named(n)[0];
      const p = n.parent();
      if (!e || !p || !csArrowReturnsValue(p) || /^(default|null)!?$/.test(e.text())) return;
      emit('return-value', start(e), end(e), 'default!');
      return;
    }
  }
}

/**
 * Declares pattern/out variables (`x is Foo f`, `out var v`, `x is { } f`):
 * negating the condition or swapping `&&`/`||` leaves them unassigned where used.
 */
function csDeclaresVariables(c: Node): boolean {
  if (CS_DESIGNATIONS.some((d) => c.has({ rule: { kind: d } }))) return true;
  return c
    .findAll({ rule: { any: [{ kind: 'recursive_pattern' }, { kind: 'list_pattern' }] } })
    .some((p) => named(p).length > 1 && named(p).at(-1)!.kind() === 'identifier');
}

/**
 * `stmt` uses a parameter of an enclosing lambda: how a lambda uses its
 * parameters can pick the overload it binds to (`app.Use((ctx, next) => …)`),
 * so removing the use may make the call ambiguous.
 */
function csUsesLambdaParameter(stmt: Node): boolean {
  const params = new Set<string>();
  for (const a of stmt.ancestors()) {
    if (a.kind() !== 'lambda_expression' && a.kind() !== 'anonymous_method_expression') continue;
    for (const c of named(a)) {
      if (c.kind() === 'implicit_parameter') params.add(c.text());
      if (c.kind() === 'parameter_list')
        for (const p of named(c)) {
          const name = (p.field('name' as never) as Node | null)?.text();
          if (name) params.add(name);
        }
    }
  }
  return params.size > 0 && stmt.findAll({ rule: { kind: 'identifier' } }).some((i) => params.has(i.text()));
}

/** Expression-bodied member that returns a value (`int P => x;`, `int F() => x;`, `get => x;`). */
function csArrowReturnsValue(p: Node): boolean {
  switch (p.kind()) {
    case 'property_declaration':
    case 'indexer_declaration':
    case 'operator_declaration':
    case 'conversion_operator_declaration':
      return true;
    case 'accessor_declaration':
      return p.child(0)?.text() === 'get';
    case 'method_declaration':
    case 'local_function_statement': {
      const t = (p.field('returns' as never) ?? p.field('type' as never)) as Node | null;
      if (!t || t.text() === 'void' || p.has({ rule: { kind: 'ref_type' } })) return false;
      const async = p.children().some((c) => c.kind() === 'modifier' && c.text() === 'async');
      return !(async && /(^|\.)(Task|ValueTask)$/.test(t.text()));
    }
  }
  return false;
}

/** Literal used as an index/dictionary key (`d["k"]`, `["k"] = v`, `{ "k", v }`). */
function csKey(n: Node): boolean {
  const p = n.parent();
  if (!p) return false;
  const gp = p.parent()?.kind();
  if (p.kind() === 'argument' && (gp === 'bracketed_argument_list' || gp === 'element_binding_expression')) return true;
  if (p.kind() === 'element_binding_expression') return true;
  return (
    p.kind() === 'initializer_expression' &&
    p.parent()?.kind() === 'initializer_expression' &&
    named(p)[0]?.range().start.index === start(n)
  );
}

/** Expression that is (syntactically) a C# string. */
function csStringish(n: Node | null, root: Node, depth: number): boolean {
  if (!n || depth > 4) return false;
  const k = String(n.kind());
  if (CS_STRING.has(k)) return true;
  switch (k) {
    case 'parenthesized_expression':
      return named(n).some((c) => csStringish(c, root, depth + 1));
    case 'binary_expression':
      return (
        (n.field('operator' as never) as Node | null)?.text() === '+' &&
        (csStringish(n.field('left' as never), root, depth + 1) ||
          csStringish(n.field('right' as never), root, depth + 1))
      );
    case 'conditional_expression':
      return named(n)
        .slice(1)
        .some((c) => csStringish(c, root, depth + 1));
    case 'invocation_expression':
      return CS_STRING_CALL.test(named(n)[0]?.text() ?? '');
    case 'member_access_expression': {
      if (/^(string|String)\.Empty$/.test(n.text())) return true;
      const member = (n.field('name' as never) as Node | null)?.text();
      return !!member && csNameIsString(member, undefined, root, depth);
    }
    case 'identifier':
      return csNameIsString(
        n.text(),
        n.ancestors().find((a) => CS_FUNCS.has(a.kind())),
        root,
        depth,
      );
  }
  return false;
}

/** Local, parameter, field, property or record member `name` is declared `string` (in this file). */
function csNameIsString(name: string, fn: Node | undefined, root: Node, depth: number): boolean {
  const isString = (t: Node | null | undefined) => !!t && /^(string|String)\??$/.test(t.text());
  const paramName = (p: Node) => (p.field('name' as never) as Node | null)?.text();
  for (const p of fn?.findAll({ rule: { kind: 'parameter' } }) ?? [])
    if (paramName(p) === name) return isString(p.field('type' as never));
  for (const scope of fn ? [fn, root] : [root]) {
    for (const d of scope.findAll({ rule: { kind: 'variable_declaration' } })) {
      const decl = named(d).find(
        (v) =>
          v.kind() === 'variable_declarator' && named(v)[0]?.kind() === 'identifier' && named(v)[0]!.text() === name,
      );
      if (!decl) continue;
      const t = d.field('type' as never) as Node | null;
      if (t?.kind() !== 'implicit_type') return isString(t);
      const init = named(decl).at(-1);
      return named(decl).length > 1 && csStringish(init!, root, depth + 1);
    }
  }
  for (const p of root.findAll({ rule: { kind: 'property_declaration' } }))
    if (paramName(p) === name) return isString(p.field('type' as never));
  // positional record / primary-constructor parameters
  for (const p of root.findAll({ rule: { kind: 'parameter' } }))
    if (paramName(p) === name && !CS_FUNCS.has(p.parent()?.parent()?.kind())) return isString(p.field('type' as never));
  return false;
}

export function applyMutant(text: string, m: Mutant): string {
  if (text.slice(m.start, m.end) !== m.original) throw new Error(`mutant ${m.id} does not apply`);
  return text.slice(0, m.start) + m.replacement + text.slice(m.end);
}

/** Deterministic, evenly spread subset (keeps operator variety across the change). */
export function selectMutants(all: Mutant[], max: number): Mutant[] {
  if (all.length <= max) return all;
  const picked: Mutant[] = [];
  for (let i = 0; i < max; i++) picked.push(all[Math.floor((i * all.length) / max)]!);
  return picked;
}
