/**
 * Structural rule engine on ast-grep (tree-sitter): rules are code patterns
 * with metavariables (`$X`, `$$$ARGS`) or full ast-grep rule objects. Scans
 * whole trees or only the lines a change touched.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { Lang, parse, type SgNode } from '@ast-grep/napi';

export type RuleLanguage = 'javascript' | 'typescript';

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

const EXT_LANG: Record<string, Lang> = {
  '.js': Lang.JavaScript,
  '.mjs': Lang.JavaScript,
  '.cjs': Lang.JavaScript,
  '.jsx': Lang.JavaScript,
  '.ts': Lang.TypeScript,
  '.mts': Lang.TypeScript,
  '.cts': Lang.TypeScript,
  '.tsx': Lang.Tsx,
};

const RULE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function validateRule(raw: unknown, source = 'rule'): Rule {
  const r = raw as Rule;
  if (!r || typeof r !== 'object') throw new Error(`${source}: not an object`);
  if (!RULE_ID.test(r.id ?? '')) throw new Error(`${source}: id must match ${RULE_ID}`);
  if (!r.message) throw new Error(`${source}: message required`);
  if (!['error', 'warning', 'info'].includes(r.severity))
    throw new Error(`${source}: severity must be error|warning|info`);
  if (r.language !== 'javascript' && r.language !== 'typescript')
    throw new Error(`${source}: language must be javascript|typescript`);
  if (!!r.pattern === !!r.rule) throw new Error(`${source}: exactly one of pattern or rule`);
  // compile check
  const probe = parse(r.language === 'typescript' ? Lang.TypeScript : Lang.JavaScript, '0').root();
  try {
    probe.findAll(r.pattern ? r.pattern : ({ rule: r.rule } as never));
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

function langFor(file: string): Lang | undefined {
  return EXT_LANG[extname(file)];
}

function applies(rule: Rule, file: string, lang: Lang): boolean {
  if (rule.paths?.length && !rule.paths.some((p) => file.startsWith(p))) return false;
  // JS rules apply to TS too (TS is a superset for the patterns we generate); TS rules only to TS.
  return rule.language === 'javascript' || lang !== Lang.JavaScript;
}

export function scanSource(rules: Rule[], file: string, text: string): Finding[] {
  const lang = langFor(file);
  if (!lang) return [];
  const active = rules.filter((r) => applies(r, file, lang));
  if (!active.length) return [];
  const root = parse(lang, text).root();
  const out: Finding[] = [];
  for (const r of active) {
    const nodes: SgNode[] = r.pattern ? root.findAll(r.pattern) : root.findAll({ rule: r.rule } as never);
    for (const n of nodes) {
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

const SKIP = new Set(['node_modules', '.git', 'dist', '.sluice', 'coverage']);

export function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && langFor(e.name) && statSync(p).size < 2_000_000) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

export function scanTree(rules: Rule[], dir: string): Finding[] {
  return listSourceFiles(dir).flatMap((f) => scanSource(rules, f, readFileSync(join(dir, f), 'utf8')));
}

/** Findings that start on one of the given changed lines (per file). */
export function onChangedLines(findings: Finding[], changed: Record<string, [number, number][]>): Finding[] {
  return findings.filter((f) => (changed[f.file] ?? []).some(([a, b]) => f.line >= a && f.line <= b));
}
