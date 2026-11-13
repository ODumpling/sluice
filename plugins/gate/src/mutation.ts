/**
 * Mutation proof: deliberately break the code the change touched and show the
 * approved checks notice. Mutants are generated with the TypeScript compiler
 * API (parses JS and TS) only on lines the PR changed.
 */
import ts from 'typescript';
import { git } from '@sluice-dev/sandbox';

export type LineRanges = Record<string, [number, number][]>;

/** Changed line ranges on the head side of `git diff base head` (1-based, inclusive). */
export async function changedLines(
  repoDir: string,
  base: string,
  head: string,
  pathspecs: string[] = [],
): Promise<LineRanges> {
  const out = await git(['diff', '-U0', '--no-color', '--no-ext-diff', base, head, '--', ...pathspecs], repoDir);
  const ranges: LineRanges = {};
  let file: string | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? undefined : line.slice(6);
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) (ranges[file] ??= []).push([start, start + count - 1]);
    }
  }
  return ranges;
}

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

export const MUTABLE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'];

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
  return out
    .sort((a, b) => a.start - b.start || a.operator.localeCompare(b.operator))
    .map((m, i) => ({ ...m, id: `${file}:${m.line}:${m.operator}:${i}` }));
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
