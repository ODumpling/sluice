/**
 * Shared model for the per-language symbol providers behind `SymbolIndex`.
 */
import type { Language, parseSource } from '@sluice-dev/lang';

export type SymbolKind =
  | 'interface'
  | 'type'
  | 'class'
  | 'struct'
  | 'record'
  | 'enum'
  | 'delegate'
  | 'function'
  | 'method'
  | 'variable'
  | 'const';

/** One declaration span (1-based, inclusive lines). */
export interface SymbolSpan {
  file: string;
  startLine: number;
  endLine: number;
}

export interface SymbolInfo {
  id: string;
  file: string;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  startLine: number;
  endLine: number;
  /** Normalized public shape (type text / function signature), used to detect interface changes. */
  signature: string;
  language: Language;
  /**
   * Every declaration span when the symbol is declared in more than one place
   * (C# partial types, Go `init` functions). `file`/`startLine`/`endLine` are the first part.
   */
  parts?: SymbolSpan[];
  /** Id of the enclosing symbol (C# nested types). */
  container?: string;
}

export interface Reference {
  file: string;
  line: number;
}

/** A language's symbols and references over a set of files. */
export interface SymbolProvider {
  readonly symbols: SymbolInfo[];
  /** References to a symbol owned by this provider (any order, may repeat). */
  references(id: string): Reference[];
}

export type SgNode = ReturnType<ReturnType<typeof parseSource>['root']>;

export const lineOf = (n: SgNode) => n.range().start.line + 1;
export const endLineOf = (n: SgNode) => n.range().end.line + 1;

/** Collapse whitespace (also around punctuation) so formatting-only edits compare equal. */
export const ws = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}()[\];,:<>=|&?*.])\s*/g, '$1')
    .trim();

/** `node`'s text with the given descendants (and, by default, comments) cut out. */
export function textWithout(node: SgNode, cut: (SgNode | null | undefined)[] = [], dropComments = true): string {
  const base = node.range().start.index;
  const text = node.text();
  const spans: [number, number][] = [];
  const add = (c: SgNode) => spans.push([c.range().start.index - base, c.range().end.index - base]);
  for (const c of cut) if (c) add(c);
  if (dropComments) for (const c of node.findAll({ rule: { kind: 'comment' } })) add(c);
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [s, e] of spans) {
    if (s > pos) out += text.slice(pos, s);
    pos = Math.max(pos, e);
  }
  return out + text.slice(pos);
}

/** Lexical scope used for shadowing checks (Go and C#). */
export class Scope<T = unknown> {
  private readonly names = new Map<string, T>();
  constructor(readonly parent?: Scope<T>) {}
  declare(name: string, v: T): void {
    if (name && name !== '_') this.names.set(name, v);
  }
  lookup(name: string): T | undefined {
    return this.names.get(name) ?? this.parent?.lookup(name);
  }
}

/** Accumulates references per symbol id for one file. */
export class RefSink {
  readonly byId = new Map<string, number[]>();
  add(id: string, n: SgNode): void {
    let a = this.byId.get(id);
    if (!a) this.byId.set(id, (a = []));
    a.push(lineOf(n));
  }
}
