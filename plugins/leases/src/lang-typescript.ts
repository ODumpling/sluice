/**
 * TS/JS symbols via the TypeScript language service (the engine behind
 * tsserver / typescript-language-server). Top-level declarations get ids
 * `path#Name`; references are resolved semantically (imports, re-exports,
 * type positions), not by text search.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { languageOf } from '@sluice-dev/lang';
import type { Reference, SymbolInfo, SymbolProvider } from './model.js';

const norm = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}();,:<>=|&?])\s*/g, '$1')
    .trim();

function isExported(n: ts.Node): boolean {
  return (
    !!ts.getCombinedModifierFlags(n as ts.Declaration) &&
    (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export) !== 0
  );
}

export class TypeScriptProvider implements SymbolProvider {
  private readonly service: ts.LanguageService;
  private readonly byId = new Map<string, { info: SymbolInfo; namePos: number }>();

  constructor(
    readonly root: string,
    readonly files: string[],
  ) {
    const versions = new Map(files.map((f) => [f, '1']));
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => files.map((f) => join(root, f)),
      getScriptVersion: (f) => versions.get(relative(root, f)) ?? '1',
      getScriptSnapshot: (f) => {
        try {
          return ts.ScriptSnapshot.fromString(readFileSync(f, 'utf8'));
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => root,
      getCompilationSettings: () => ({
        allowJs: true,
        checkJs: false,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
      }),
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    for (const f of files) this.indexFile(f);
  }

  get symbols(): SymbolInfo[] {
    return [...this.byId.values()].map((v) => v.info);
  }

  private indexFile(file: string): void {
    const sf = this.service.getProgram()!.getSourceFile(join(this.root, file));
    if (!sf) return;
    const language = languageOf(file) ?? 'typescript';
    const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const add = (
      name: ts.Identifier,
      node: ts.Node,
      kind: SymbolInfo['kind'],
      signature: string,
      exported: boolean,
    ) => {
      const id = `${file}#${name.text}`;
      this.byId.set(id, {
        info: {
          id,
          file,
          name: name.text,
          kind,
          exported,
          startLine: line(node.getStart(sf)),
          endLine: line(node.getEnd()),
          signature: norm(signature),
          language,
        },
        namePos: name.getStart(sf),
      });
    };
    for (const st of sf.statements) {
      const exported = isExported(st);
      if (ts.isInterfaceDeclaration(st))
        add(st.name, st, 'interface', st.getText(sf).replace(/^export\s+/, ''), exported);
      else if (ts.isTypeAliasDeclaration(st))
        add(st.name, st, 'type', st.getText(sf).replace(/^export\s+/, ''), exported);
      else if (ts.isEnumDeclaration(st)) add(st.name, st, 'enum', st.getText(sf).replace(/^export\s+/, ''), exported);
      else if (ts.isClassDeclaration(st) && st.name) {
        const members = st.members
          .filter((m) => !(ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Private))
          .map((m) =>
            ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)
              ? m.getText(sf).replace(/\{[\s\S]*$/, '')
              : m.getText(sf),
          )
          .join(';');
        add(st.name, st, 'class', `class ${st.name.text}{${members}}`, exported);
      } else if (ts.isFunctionDeclaration(st) && st.name) {
        const sig = `${st.name.text}(${st.parameters.map((p) => p.getText(sf)).join(',')})${st.type ? ':' + st.type.getText(sf) : ''}`;
        add(st.name, st, 'function', sig, exported);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const init = d.initializer;
          const sig =
            init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
              ? `${d.name.text}(${init.parameters.map((p) => p.getText(sf)).join(',')})${init.type ? ':' + init.type.getText(sf) : ''}`
              : `${d.name.text}${d.type ? ':' + d.type.getText(sf) : ''}`;
          add(
            d.name,
            st,
            init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? 'function' : 'variable',
            sig,
            exported,
          );
        }
      }
    }
  }

  references(id: string): Reference[] {
    const entry = this.byId.get(id);
    if (!entry) return [];
    const refs = this.service.findReferences(join(this.root, entry.info.file), entry.namePos) ?? [];
    const out: Reference[] = [];
    for (const r of refs) {
      for (const ref of r.references) {
        if (ref.isDefinition) continue;
        const file = relative(this.root, ref.fileName);
        if (file.startsWith('..')) continue;
        const sf = this.service.getProgram()!.getSourceFile(ref.fileName)!;
        out.push({ file, line: sf.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1 });
      }
    }
    return out;
  }
}
