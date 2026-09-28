/**
 * Module resolution as the project's TypeScript sees it, and the module graph of a build's entry points.
 */
import path from 'node:path';
import ts from 'typescript';
import { sourceCache } from './cache.js';

/** A module specifier to the project's own source file it names, or null for packages and anything unresolved */
export type ModuleResolver = (specifier: string, fromFile: string) => string | null;

const readCompilerOptions = (projectRoot: string): ts.CompilerOptions => {
  const fallback: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  };
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return fallback;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return fallback;
  const { options } = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  return { ...fallback, ...options };
};

/**
 * TypeScript's module resolution with the project's tsconfig (paths, extensions, index files). `thane`
 * and other packages resolve to null: they hold no source of the project's.
 */
export const createModuleResolver = (projectRoot: string): ModuleResolver => {
  const options = readCompilerOptions(projectRoot);
  const cache = ts.createModuleResolutionCache(
    projectRoot,
    (name) => (ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase()),
    options,
  );
  return (specifier, fromFile) => {
    if (specifier === 'thane' || specifier.startsWith('thane/')) return null;
    const resolved = ts.resolveModuleName(specifier, fromFile, options, ts.sys, cache).resolvedModule;
    if (!resolved || resolved.isExternalLibraryImport || resolved.resolvedFileName.endsWith('.d.ts')) return null;
    return resolved.resolvedFileName;
  };
};

/** The specifiers a module imports: static imports and re-exports, and `import('…')` with a literal. */
const importedSpecifiers = (sourceFile: ts.SourceFile): string[] => {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

/**
 * Every TypeScript source the entry points reach: through static imports, re-exports and `import()`
 * calls (lazily loaded routes), within the project. Absolute paths, entry points first.
 */
export const collectModuleGraph = async (entryPoints: string[], resolve: ModuleResolver): Promise<string[]> => {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = entryPoints.map((entry) => path.resolve(entry));
  while (queue.length > 0) {
    const file = queue.shift()!;
    const key = ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase();
    if (seen.has(key) || !/\.[cm]?tsx?$/.test(file) || file.endsWith('.d.ts')) continue;
    seen.add(key);
    const cached = await sourceCache.get(file);
    if (!cached) continue;
    order.push(file);
    for (const specifier of importedSpecifiers(cached.sourceFile)) {
      const target = resolve(specifier, file);
      if (target) queue.push(path.resolve(target));
    }
  }
  return order;
};
