/**
 * Which components a file can call in its templates: the ones it declares, exported or not, and the ones it
 * imports, under the names it gives them; and which fragments it imports (`export const Name = html\`…\``
 * of another module). An import is followed to the file that defines the component or the fragment, through
 * re-exports (`export { Card } from`, `export * from`, `export { Card }` of an imported binding), with
 * TypeScript's module resolution and the project's tsconfig (paths, extensions, index files). A call to
 * any other name is an ordinary expression, whatever components elsewhere in the project are called.
 */
import path from 'node:path';
import ts from 'typescript';
import type { ComponentDefinition, FragmentDefinition } from '../types.js';
import { extractComponentDefinitions, extractFragmentDefinitions } from './ast-utils.js';
import { sourceCache } from './cache.js';
import { createModuleResolver } from './module-graph.js';

/** Re-export chains longer than this are not followed (a cycle, or a pathological barrel). */
const MAX_REEXPORT_DEPTH = 16;

const fileKey = (filePath: string): string => {
  const resolved = path.resolve(filePath);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
};

export interface ComponentResolver {
  /** The components `sourceFile` can call, keyed by the name it calls them. */
  componentsInScope(sourceFile: ts.SourceFile): Promise<Map<string, ComponentDefinition>>;
  /** The fragments `sourceFile` imports, keyed by the name it uses them under. */
  fragmentsInScope(sourceFile: ts.SourceFile): Promise<Map<string, FragmentDefinition>>;
}

/** The named, non-type imports of a file: each local name, the name it imports, and the module it is from */
const namedImports = function* (
  sourceFile: ts.SourceFile,
): Generator<{ local: string; imported: string; specifier: string }> {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
      !bindings ||
      !ts.isNamedImports(bindings)
    )
      continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      yield { local: element.name.text, imported, specifier: statement.moduleSpecifier.text };
    }
  }
};

/**
 * @param projectRoot - where the project's tsconfig.json is looked up
 * @param scanned - the definitions the build's scan found; a file outside the scan is read when an
 *   import leads to it
 */
export const createComponentResolver = (
  projectRoot: string,
  scanned: Iterable<ComponentDefinition>,
): ComponentResolver => {
  const resolveImport = createModuleResolver(projectRoot);

  const parsedFile = async (filePath: string): Promise<ts.SourceFile | null> =>
    (await sourceCache.get(path.resolve(filePath)))?.sourceFile ?? null;

  /**
   * Finding one kind of definition, by the name a file declares or imports it under: each file's own,
   * read from `extract` (and seeded with `seed`), and the imports and re-exports that lead to them
   */
  const lookup = <T extends { name: string; exported: boolean }>(
    extract: (sourceFile: ts.SourceFile, filePath: string) => T[],
    seed: Iterable<T & { filePath: string }> = [],
  ) => {
    const definitionsByFile = new Map<string, Map<string, T>>();
    for (const def of seed) {
      const key = fileKey(def.filePath);
      let defs = definitionsByFile.get(key);
      if (!defs) definitionsByFile.set(key, (defs = new Map()));
      defs.set(def.name, def);
    }

    const definitionsIn = async (filePath: string): Promise<Map<string, T>> => {
      const key = fileKey(filePath);
      let defs = definitionsByFile.get(key);
      if (!defs) {
        defs = new Map();
        const sourceFile = await parsedFile(filePath);
        if (sourceFile) for (const def of extract(sourceFile, path.resolve(filePath))) defs.set(def.name, def);
        definitionsByFile.set(key, defs);
      }
      return defs;
    };

    /** The definition a local name refers to in a file: a declaration of its own, or an import */
    const resolveLocal = async (sourceFile: ts.SourceFile, localName: string, depth: number): Promise<T | null> => {
      const own = (await definitionsIn(sourceFile.fileName)).get(localName);
      if (own) return own;
      for (const { local, imported, specifier } of namedImports(sourceFile)) {
        if (local !== localName) continue;
        const target = resolveImport(specifier, sourceFile.fileName);
        return target ? exported(target, imported, depth + 1) : null;
      }
      return null;
    };

    /** The definition a file exports under `name`, following its re-exports */
    const exported = async (filePath: string, name: string, depth: number): Promise<T | null> => {
      if (depth > MAX_REEXPORT_DEPTH) return null;
      const own = (await definitionsIn(filePath)).get(name);
      if (own?.exported) return own;
      const sourceFile = await parsedFile(filePath);
      if (!sourceFile) return null;
      for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
        const from =
          statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? resolveImport(statement.moduleSpecifier.text, sourceFile.fileName)
            : null;
        const clause = statement.exportClause;
        if (!clause) {
          // export * from '…'
          const found = from ? await exported(from, name, depth + 1) : null;
          if (found) return found;
          continue;
        }
        if (!ts.isNamedExports(clause)) continue;
        for (const element of clause.elements) {
          if (element.isTypeOnly || element.name.text !== name) continue;
          const original = (element.propertyName ?? element.name).text;
          if (statement.moduleSpecifier) return from ? exported(from, original, depth + 1) : null;
          // export { Card }: a binding of this file, often an imported one
          return resolveLocal(sourceFile, original, depth);
        }
      }
      return null;
    };

    /** The definitions a file imports, by their local names; `thane` and other packages declare none */
    const imported = async (sourceFile: ts.SourceFile, into: Map<string, T>): Promise<Map<string, T>> => {
      for (const { local, imported: name, specifier } of namedImports(sourceFile)) {
        const target = resolveImport(specifier, sourceFile.fileName);
        const def = target ? await exported(target, name, 1) : null;
        if (def) into.set(local, def);
      }
      return into;
    };

    return { definitionsIn, imported };
  };

  const components = lookup<ComponentDefinition>(extractComponentDefinitions, scanned);
  const fragments = lookup<FragmentDefinition>(extractFragmentDefinitions);

  return {
    async componentsInScope(sourceFile) {
      return components.imported(sourceFile, new Map(await components.definitionsIn(sourceFile.fileName)));
    },
    // A file's own fragments are inlined where its templates use them
    fragmentsInScope: (sourceFile) => fragments.imported(sourceFile, new Map()),
  };
};
