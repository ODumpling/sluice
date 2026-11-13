/**
 * Structural codemods on ast-grep: `pattern` with metavariables ($A, $$$ARGS)
 * rewritten to a template using the same metavariables. Rules apply in order;
 * the tree is re-parsed between rules so later rules see earlier rewrites.
 * Languages: JavaScript/TypeScript (one family), Go, C#.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Edit, SgNode } from '@ast-grep/napi';
import { LANGUAGES, isLanguage, languageOf, listSourceFiles, parseSource, type Language } from '@sluice-dev/lang';
import { findPattern } from '@sluice-dev/policy';

export interface CodemodRule {
  pattern: string;
  rewrite: string;
}

export interface Codemod {
  language: Language;
  rules: CodemodRule[];
  /** Only files under these prefixes. */
  paths?: string[];
}

/** Languages a codemod touches: JS and TS codemods cover both; Go and C# only their own files. */
export function codemodLanguages(language: Language): Language[] {
  if (!isLanguage(language)) throw new Error(`codemod language must be ${LANGUAGES.join('|')}`);
  return language === 'javascript' || language === 'typescript' ? ['javascript', 'typescript'] : [language];
}

const DEFAULT_FILE: Record<Language, string> = {
  javascript: 'file.js',
  typescript: 'file.ts',
  go: 'file.go',
  csharp: 'File.cs',
};

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

export function applyCodemodToSource(
  text: string,
  mod: Codemod,
  file = DEFAULT_FILE[mod.language],
): { text: string; edits: number } {
  const family = codemodLanguages(mod.language);
  const fileLang = languageOf(file);
  if (!fileLang || !family.includes(fileLang)) return { text, edits: 0 };
  // a TypeScript codemod parses .js files as TypeScript too (types in the patterns/templates)
  const lang: Language = mod.language === 'typescript' ? 'typescript' : fileLang;
  const parseAs =
    lang === 'typescript' && fileLang === 'javascript'
      ? file.replace(/\.[^.]+$/, file.endsWith('x') ? '.tsx' : '.ts')
      : file;
  // statement patterns match the trailing semicolon (JS/TS/C#); keep it if the template omits it. Go has none.
  const semicolons = lang !== 'go';
  let current = text;
  let count = 0;
  for (const r of mod.rules) {
    const root = parseSource(lang, current, parseAs).root();
    const edits: Edit[] = findPattern(root, lang, r.pattern).map((n) => {
      let out = expand(r.rewrite, n);
      if (semicolons && n.text().endsWith(';') && !out.trimEnd().endsWith(';')) out += ';';
      return n.replace(out);
    });
    if (edits.length) {
      current = root.commitEdits(edits);
      count += edits.length;
    }
  }
  return { text: current, edits: count };
}

/** Apply a codemod to every file of its language family in a tree; returns files changed. */
export function applyCodemod(dir: string, mod: Codemod): { file: string; edits: number }[] {
  const out: { file: string; edits: number }[] = [];
  for (const f of listSourceFiles(dir, codemodLanguages(mod.language))) {
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
