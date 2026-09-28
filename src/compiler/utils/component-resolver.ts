/**
 * Which components a file can call in its templates: the ones it declares, and the ones it imports,
 * under the names it gives them. An import is followed to the file that defines the component, through
 * re-exports (`export { Card } from`, `export * from`, `export { Card }` of an imported binding), with
 * TypeScript's module resolution and the project's tsconfig (paths, extensions, index files). A call to
 * any other name is an ordinary expression, whatever components elsewhere in the project are called.
 */
import path from 'node:path';
import ts from 'typescript';
import type { ComponentDefinition } from '../types.js';
import { extractComponentDefinitions } from './ast-utils.js';
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
}

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

  const definitionsByFile = new Map<string, Map<string, ComponentDefinition>>();
  for (const def of scanned) {
    const key = fileKey(def.filePath);
    let defs = definitionsByFile.get(key);
    if (!defs) definitionsByFile.set(key, (defs = new Map()));
    defs.set(def.name, def);
  }

  const parsedFile = async (filePath: string): Promise<ts.SourceFile | null> =>
    (await sourceCache.get(path.resolve(filePath)))?.sourceFile ?? null;

  const definitionsIn = async (filePath: string): Promise<Map<string, ComponentDefinition>> => {
    const key = fileKey(filePath);
    let defs = definitionsByFile.get(key);
    if (!defs) {
      defs = new Map();
      const sourceFile = await parsedFile(filePath);
      if (sourceFile) {
        for (const def of extractComponentDefinitions(sourceFile, path.resolve(filePath))) defs.set(def.name, def);
      }
      definitionsByFile.set(key, defs);
    }
    return defs;
  };

  /** The component a local name refers to in a file: a declaration of its own, or an import */
  const resolveLocal = async (
    sourceFile: ts.SourceFile,
    localName: string,
    depth: number,
  ): Promise<ComponentDefinition | null> => {
    const own = (await definitionsIn(sourceFile.fileName)).get(localName);
    if (own) return own;
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
        if (element.isTypeOnly || element.name.text !== localName) continue;
        const target = resolveImport(statement.moduleSpecifier.text, sourceFile.fileName);
        return target ? exported(target, (element.propertyName ?? element.name).text, depth + 1) : null;
      }
    }
    return null;
  };

  /** The component a file exports under `name`, following its re-exports */
  const exported = async (filePath: string, name: string, depth: number): Promise<ComponentDefinition | null> => {
    if (depth > MAX_REEXPORT_DEPTH) return null;
    const own = (await definitionsIn(filePath)).get(name);
    if (own) return own;
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

  return {
    async componentsInScope(sourceFile) {
      const scope = new Map<string, ComponentDefinition>();
      for (const [name, def] of await definitionsIn(sourceFile.fileName)) scope.set(name, def);
      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (
          statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
          !bindings ||
          !ts.isNamedImports(bindings)
        )
          continue;
        // `thane` and other packages declare no components the compiler can mount
        const target = resolveImport(statement.moduleSpecifier.text, sourceFile.fileName);
        if (!target) continue;
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          const def = await exported(target, (element.propertyName ?? element.name).text, 1);
          if (def) scope.set(element.name.text, def);
        }
      }
      return scope;
    },
  };
};
