/**
 * Review comment -> proposed rule -> proof.
 *
 * A reviewer's comment ("don't call `stripe.subscriptions.cancel()` here…")
 * becomes candidate structural rules. A candidate is only adopted once it is
 * *proven*: it must flag the commit the comment was made on (on lines that
 * commit changed) and produce zero findings on main. Candidates that miss the
 * bad code, or that would fire all over main, are rejected with the evidence.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Lang, parse, type SgNode } from '@ast-grep/napi';
import {
  loadRuleFile,
  onChangedLines,
  ruleToYaml,
  scanSource,
  scanTree,
  validateRule,
  type Finding,
  type Rule,
  type RuleLanguage,
} from '@sluice-dev/policy';
import { changedLines, checkoutRef, git } from '@sluice-dev/sandbox';

export interface ReviewComment {
  body: string;
  path?: string;
  line?: number;
  author?: string;
  url?: string;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function firstSentence(body: string): string {
  const s = body.replace(/\s+/g, ' ').trim();
  const m = /^(.{10,200}?[.!?])(\s|$)/.exec(s);
  return (m ? m[1]! : s.slice(0, 200)).trim();
}

/** Generalize a call: keep the callee, match any arguments. */
function generalize(node: SgNode): string | undefined {
  const kind = node.kind();
  if (kind === 'call_expression') {
    const callee = node.field('function');
    return callee ? `${callee.text()}($$$)` : undefined;
  }
  if (kind === 'new_expression') {
    const ctor = node.field('constructor');
    return ctor ? `new ${ctor.text()}($$$)` : undefined;
  }
  if (kind === 'member_expression' || kind === 'identifier') return node.text().length >= 4 ? node.text() : undefined;
  return undefined;
}

function expressionOf(code: string, lang: Lang): SgNode | undefined {
  try {
    const root = parse(lang, code).root();
    if (root.children().length !== 1) return undefined;
    const stmt = root.children()[0]!;
    if (stmt.kind() !== 'expression_statement') return undefined;
    return stmt.children().find((c) => c.isNamed());
  } catch {
    return undefined;
  }
}

/** Candidate rules from a review comment: code spans first, else the code at the commented line. */
export function proposeFromComment(c: ReviewComment, opts: { sourceAtPath?: string } = {}): Rule[] {
  const language: RuleLanguage = c.path && /\.(m|c)?tsx?$/.test(extname(c.path)) ? 'typescript' : 'javascript';
  const lang = language === 'typescript' ? Lang.TypeScript : Lang.JavaScript;
  const patterns: string[] = [];
  for (const m of c.body.matchAll(/`([^`\n]+)`/g)) {
    const expr = expressionOf(m[1]!.trim(), lang);
    const p = expr && generalize(expr);
    if (p && !patterns.includes(p)) patterns.push(p);
  }
  if (!patterns.length && c.line && opts.sourceAtPath) {
    const root = parse(lang, opts.sourceAtPath).root();
    const calls = root
      .findAll({ rule: { kind: 'call_expression' } } as never)
      .filter((n) => n.range().start.line + 1 === c.line);
    const outer = calls.sort((a, b) => b.text().length - a.text().length)[0];
    const p = outer && generalize(outer);
    if (p) patterns.push(p);
  }
  return patterns.map((pattern) =>
    validateRule(
      {
        id: `review-${slug(pattern.replace(/\(\$\$\$\)/g, ''))}`,
        message: firstSentence(c.body),
        severity: 'error',
        language,
        pattern,
        source: { comment: c.body, path: c.path, line: c.line, author: c.author, url: c.url },
      },
      `proposal from comment`,
    ),
  );
}

export interface Proof {
  rule: string;
  proven: boolean;
  reason: string;
  bad: { sha: string; findings: Finding[] };
  main: { ref: string; sha: string; findings: Finding[] };
}

/** Prove a rule: it must flag lines changed by `bad` and be clean on `main`. */
export async function proveRule(rule: Rule, o: { repo: string; bad: string; main: string }): Promise<Proof> {
  const badSha = (await git(['rev-parse', '--verify', `${o.bad}^{commit}`], o.repo)).trim();
  const mainSha = (await git(['rev-parse', '--verify', `${o.main}^{commit}`], o.repo)).trim();
  const ranges = await changedLines(o.repo, `${badSha}^`, badSha);
  const badFindings: Finding[] = [];
  for (const file of Object.keys(ranges)) {
    const text = await git(['show', `${badSha}:${file}`], o.repo).catch(() => undefined);
    if (text !== undefined) badFindings.push(...onChangedLines(scanSource([rule], file, text), ranges));
  }
  const co = await checkoutRef(o.repo, mainSha);
  let mainFindings: Finding[];
  try {
    mainFindings = scanTree([rule], co.dir);
  } finally {
    await co.remove();
  }
  const proven = badFindings.length > 0 && mainFindings.length === 0;
  const reason = proven
    ? `flags ${badFindings.length} changed line(s) in ${badSha.slice(0, 8)} and is clean on ${o.main}`
    : badFindings.length === 0
      ? `does not flag anything the commit changed`
      : `fires ${mainFindings.length} time(s) on ${o.main} (would be noise)`;
  return {
    rule: rule.id,
    proven,
    reason,
    bad: { sha: badSha, findings: badFindings },
    main: { ref: o.main, sha: mainSha, findings: mainFindings },
  };
}

export const RULES_DIR = join('.sluice', 'rules');

export class RuleStore {
  constructor(readonly root: string) {}
  private dir(kind: 'active' | 'proposed'): string {
    return kind === 'active' ? join(this.root, RULES_DIR) : join(this.root, RULES_DIR, 'proposed');
  }
  save(rule: Rule, kind: 'active' | 'proposed'): string {
    mkdirSync(this.dir(kind), { recursive: true });
    const f = join(this.dir(kind), `${rule.id}.yaml`);
    writeFileSync(f, ruleToYaml(rule));
    return f;
  }
  list(kind: 'active' | 'proposed'): Rule[] {
    const d = this.dir(kind);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.yaml'))
      .sort()
      .map((f) => loadRuleFile(join(d, f)));
  }
  get(id: string, kind: 'active' | 'proposed'): Rule | undefined {
    return this.list(kind).find((r) => r.id === id);
  }
  /** Adopt a proven rule: record the proof in its provenance and activate it. */
  adopt(rule: Rule, proof: Proof): string {
    if (!proof.proven) throw new Error(`rule ${rule.id} is not proven: ${proof.reason}`);
    return this.save(
      {
        ...rule,
        source: {
          ...rule.source,
          proof: {
            badCommit: proof.bad.sha,
            flagged: proof.bad.findings.map((f) => `${f.file}:${f.line}`),
            cleanOn: `${proof.main.ref}@${proof.main.sha}`,
          },
        },
      },
      'active',
    );
  }
}

export function readText(file: string): string {
  return readFileSync(file, 'utf8');
}
