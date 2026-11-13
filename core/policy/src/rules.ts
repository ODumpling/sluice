/**
 * Structural rule engine on ast-grep (tree-sitter): rules are code patterns
 * with metavariables (`$X`, `$$$ARGS`) or full ast-grep rule objects. Scans
 * whole trees or only the lines a change touched. Languages: JavaScript,
 * TypeScript, Go and C#.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { SgNode, SgRoot } from '@ast-grep/napi';
import { LANGUAGES, isLanguage, languageOf, listSourceFiles, parseSource, type Language } from '@sluice-dev/lang';

export { listSourceFiles };

export type RuleLanguage = Language;

export interface Rule {
  id: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  language: RuleLanguage;
  /** Simple form: a code pattern. */
  pattern?: string;
  /** Full ast-grep rule object (pattern/kind/inside/has/not/all/any). */
  rule?: Record<string, unknown>;
  /** Only files whose path starts with one of these prefixes. */
  paths?: string[];
  /** Provenance (e.g. the review comment this rule came from). */
  source?: Record<string, unknown>;
}

export interface Finding {
  rule: string;
  severity: Rule['severity'];
  message: string;
  file: string;
  line: number;
  column: number;
  text: string;
}

// ------------------------------------------------------------ pattern compile

/** An ast-grep pattern: plain code, or code parsed in a `context` with the `selector` node kind picked out. */
export type PatternSpec = string | { context: string; selector: string };

/** Go declarations that only parse at the top level of a file. */
const GO_TOP_LEVEL = /^(package|import|func|type|var|const)\b/;
const LONE_METAVAR = /^\$(\$\$)?[A-Z_][A-Z0-9_]*$|^\$\$\$$/;
const GO_PREFIX = 'package _\nfunc _() {\n';
const GO_SUFFIX = '\n}';

/** Metavariables as ast-grep's pattern preprocessor sees them (expando char µ for Go/C#). */
const expando = (p: string) => p.replace(/\$/g, 'µ');

const hasKind = (root: SgRoot, kind: string) => root.root().find({ rule: { kind } } as never) !== null;

function compileGo(pattern: string): PatternSpec {
  const p = pattern.trim();
  if (GO_TOP_LEVEL.test(p) || LONE_METAVAR.test(p)) return pattern;
  // At the top level of a file `pkg.Fn(x)` parses as a type conversion and `pkg.Field` as a
  // qualified type; inside a function body they are a call and a selector, as in real code.
  const probe = parseSource('go', GO_PREFIX + expando(p) + GO_SUFFIX);
  if (hasKind(probe, 'ERROR')) return pattern;
  const list = probe.root().find({ rule: { kind: 'statement_list' } } as never);
  const stmts = list?.children().filter((c) => c.isNamed() && c.kind() !== 'comment') ?? [];
  if (stmts.length !== 1) return pattern;
  const stmt = stmts[0]!;
  const node = stmt.kind() === 'expression_statement' ? stmt.children().find((c) => c.isNamed()) : stmt;
  return node ? { context: GO_PREFIX + p + GO_SUFFIX, selector: String(node.kind()) } : pattern;
}

function compileCsharp(pattern: string): PatternSpec {
  const p = pattern.trim();
  if (LONE_METAVAR.test(p)) return pattern;
  const probe = parseSource('csharp', expando(p));
  // `$A * $B` alone parses as a pointer declaration; `Foo.Bar` alone is an ERROR.
  if (!hasKind(probe, 'ERROR') && !hasKind(probe, 'pointer_type')) return pattern;
  if (p.endsWith(';')) return pattern;
  const context = `_ = ${p};`;
  const ctx = parseSource('csharp', `_ = ${expando(p)};`);
  if (hasKind(ctx, 'ERROR')) return pattern;
  const right = ctx
    .root()
    .find({ rule: { kind: 'assignment_expression' } } as never)
    ?.field('right');
  return right ? { context, selector: String(right.kind()) } : pattern;
}

const compiled = new Map<string, PatternSpec>();

/**
 * Compile a code pattern for a language. JS/TS patterns are used as written.
 * Go expression/statement patterns are parsed inside a function body and C#
 * expressions that do not parse on their own (`a * b`, `Foo.Bar`) on the
 * right of an assignment, so they match the way that code appears in files.
 */
export function compilePattern(language: Language, pattern: string): PatternSpec {
  if (language !== 'go' && language !== 'csharp') return pattern;
  const key = `${language}\0${pattern}`;
  let spec = compiled.get(key);
  if (spec === undefined) {
    spec = language === 'go' ? compileGo(pattern) : compileCsharp(pattern);
    compiled.set(key, spec);
  }
  return spec;
}

const RULE_KEYS = ['inside', 'has', 'precedes', 'follows', 'not'];

/** Compile every `pattern` string in a full ast-grep rule object (nested rules included). */
export function compileRuleObject(language: Language, rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rule };
  if (typeof rule.pattern === 'string') out.pattern = compilePattern(language, rule.pattern);
  for (const k of RULE_KEYS)
    if (rule[k] && typeof rule[k] === 'object')
      out[k] = compileRuleObject(language, rule[k] as Record<string, unknown>);
  for (const k of ['all', 'any'])
    if (Array.isArray(rule[k]))
      out[k] = (rule[k] as Record<string, unknown>[]).map((r) => compileRuleObject(language, r));
  return out;
}

/** Find all matches of a pattern (compiled for `language`) under a node. */
export function findPattern(node: SgNode, language: Language, pattern: string): SgNode[] {
  const spec = compilePattern(language, pattern);
  return typeof spec === 'string' ? node.findAll(spec) : node.findAll({ rule: { pattern: spec } } as never);
}

function matches(root: SgNode, r: Rule): SgNode[] {
  return r.pattern
    ? findPattern(root, r.language, r.pattern)
    : root.findAll({ rule: compileRuleObject(r.language, r.rule!) } as never);
}

// ------------------------------------------------------------------- rules

const RULE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

const PROBE: Record<Language, string> = {
  javascript: '0',
  typescript: '0',
  go: 'package p\n',
  csharp: 'class P {}\n',
};

export function validateRule(raw: unknown, source = 'rule'): Rule {
  const r = raw as Rule;
  if (!r || typeof r !== 'object') throw new Error(`${source}: not an object`);
  if (!RULE_ID.test(r.id ?? '')) throw new Error(`${source}: id must match ${RULE_ID}`);
  if (!r.message) throw new Error(`${source}: message required`);
  if (!['error', 'warning', 'info'].includes(r.severity))
    throw new Error(`${source}: severity must be error|warning|info`);
  if (!isLanguage(r.language)) throw new Error(`${source}: language must be ${LANGUAGES.join('|')}`);
  if (!!r.pattern === !!r.rule) throw new Error(`${source}: exactly one of pattern or rule`);
  // compile check
  try {
    matches(parseSource(r.language, PROBE[r.language]).root(), r);
  } catch (e) {
    throw new Error(`${source}: invalid pattern/rule: ${(e as Error).message}`, { cause: e });
  }
  return r;
}

export function loadRuleFile(file: string): Rule {
  return validateRule(parseYaml(readFileSync(file, 'utf8')), file);
}

export function ruleToYaml(r: Rule): string {
  return toYaml(r);
}

/** Languages a rule applies to: JS rules apply to TS too (TS is a superset for the patterns we generate). */
export function ruleLanguages(language: RuleLanguage): Language[] {
  return language === 'javascript' ? ['javascript', 'typescript'] : [language];
}

function applies(rule: Rule, file: string, lang: Language): boolean {
  if (rule.paths?.length && !rule.paths.some((p) => file.startsWith(p))) return false;
  return ruleLanguages(rule.language).includes(lang);
}

export function scanSource(rules: Rule[], file: string, text: string): Finding[] {
  const lang = languageOf(file);
  if (!lang) return [];
  const active = rules.filter((r) => applies(r, file, lang));
  if (!active.length) return [];
  const root = parseSource(lang, text, file).root();
  const out: Finding[] = [];
  for (const r of active) {
    for (const n of matches(root, r)) {
      const start = n.range().start;
      out.push({
        rule: r.id,
        severity: r.severity,
        message: r.message,
        file,
        line: start.line + 1,
        column: start.column + 1,
        text: n.text(),
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

export function scanTree(rules: Rule[], dir: string): Finding[] {
  if (!rules.length) return [];
  const languages = [...new Set(rules.flatMap((r) => ruleLanguages(r.language)))];
  return listSourceFiles(dir, languages).flatMap((f) => scanSource(rules, f, readFileSync(join(dir, f), 'utf8')));
}

/** Findings that start on one of the given changed lines (per file). */
export function onChangedLines(findings: Finding[], changed: Record<string, [number, number][]>): Finding[] {
  return findings.filter((f) => (changed[f.file] ?? []).some(([a, b]) => f.line >= a && f.line <= b));
}
