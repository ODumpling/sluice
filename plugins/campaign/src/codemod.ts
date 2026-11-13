/**
 * Structural codemods on ast-grep: `pattern` with metavariables ($A, $$$ARGS)
 * rewritten to a template using the same metavariables. Rules apply in order;
 * the tree is re-parsed between rules so later rules see earlier rewrites.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Lang, parse, type Edit, type SgNode } from '@ast-grep/napi';
import { listSourceFiles } from '@sluice-dev/policy';

export interface CodemodRule {
  pattern: string;
  rewrite: string;
}

export interface Codemod {
  language: 'javascript' | 'typescript';
  rules: CodemodRule[];
  /** Only files under these prefixes. */
  paths?: string[];
}

function expand(template: string, node: SgNode): string {
  return template.replace(
    /\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g,
    (whole, multi: string | undefined, single: string | undefined) => {
      if (multi) {
        const nodes = node.getMultipleMatches(multi);
        if (!nodes.length) return '';
        const src = node.getRoot().root().text();
        return src.slice(nodes[0]!.range().start.index, nodes[nodes.length - 1]!.range().end.index);
      }
      const m = node.getMatch(single!);
      if (!m) throw new Error(`codemod rewrite uses ${whole} but the pattern does not bind it`);
      return m.text();
    },
  );
}

export function applyCodemodToSource(text: string, mod: Codemod, file = 'file.js'): { text: string; edits: number } {
  const lang =
    mod.language === 'typescript' || /\.(m|c)?tsx?$/.test(file)
      ? file.endsWith('x')
        ? Lang.Tsx
        : Lang.TypeScript
      : Lang.JavaScript;
  let current = text;
  let count = 0;
  for (const r of mod.rules) {
    const root = parse(lang, current).root();
    const edits: Edit[] = root.findAll(r.pattern).map((n) => {
      let text = expand(r.rewrite, n);
      // statement patterns match the trailing semicolon; keep it if the template omits it
      if (n.text().endsWith(';') && !text.endsWith(';')) text += ';';
      return n.replace(text);
    });
    if (edits.length) {
      current = root.commitEdits(edits);
      count += edits.length;
    }
  }
  return { text: current, edits: count };
}

/** Apply a codemod to every JS/TS file of a tree; returns files changed. */
export function applyCodemod(dir: string, mod: Codemod): { file: string; edits: number }[] {
  const out: { file: string; edits: number }[] = [];
  for (const f of listSourceFiles(dir)) {
    if (mod.paths?.length && !mod.paths.some((p) => f.startsWith(p))) continue;
    const p = join(dir, f);
    const before = readFileSync(p, 'utf8');
    const r = applyCodemodToSource(before, mod, f);
    if (r.edits && r.text !== before) {
      writeFileSync(p, r.text);
      out.push({ file: f, edits: r.edits });
    }
  }
  return out;
}
