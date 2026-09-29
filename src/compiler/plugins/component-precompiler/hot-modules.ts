/**
 * Hot updates for `thane dev`: what the build records, and what it adds to each module, so that a
 * changed component file can be run again in the open page instead of reloading it.
 *
 * - Each project module registers its namespace in the page, under its path from the project root
 *   (`src/card.ts`), and the namespaces of the packages it imports (`pkg:thane`), in
 *   `globalThis.__thaneModules` (hotRegistration). A self-import gives the live bindings.
 * - Each build records which inputs changed since the last one (trackHotInput). When every changed
 *   file is a component file the page can swap (isSwappable), each is bundled on its own, with every
 *   import pointing at the page's modules (HotExternalsPlugin), and sent to the page; otherwise the
 *   page reloads.
 * - In the page, the runtime swaps the file's components in place (runtime/hot.ts).
 */
import path from 'node:path';
import ts from 'typescript';
import type { Plugin } from 'esbuild';
import { findComponentDeclarations } from '../../utils/index.js';
import { createModuleResolver } from '../../utils/module-graph.js';

/** What a `thane dev` build knows for hot updates */
export interface HotState {
  /** Each input's text as last built */
  sources: Map<string, string>;
  /** The inputs that changed in this build: true for a component file the page can swap */
  changed: Map<string, boolean>;
}

export const createHotState = (): HotState => ({ sources: new Map(), changed: new Map() });

/** Where a hot update's imports point: a project module, by its key, or a package, by its specifier */
export const HOT_MODULE_PREFIX = '__thane_module__:';
export const HOT_PACKAGE_PREFIX = '__thane_package__:';

/** The key a page registers a project module under: its path from the project root */
export const hotModuleKey = (file: string, projectRoot: string): string =>
  path.relative(projectRoot, file).replaceAll('\\', '/');

/** Record `text` as this build's input `file`; a file built before with other text has changed */
export const trackHotInput = (hot: HotState, file: string, text: string, swappable: () => boolean): void => {
  const previous = hot.sources.get(file);
  hot.sources.set(file, text);
  if (previous !== undefined && previous !== text) hot.changed.set(file, swappable());
};

/**
 * A component file the page can swap: it declares a component, and exports nothing but components (and
 * types). Anything else it exports may be held by other modules, which a swap would not reach.
 */
export const isSwappable = (sourceFile: ts.SourceFile): boolean => {
  const components = findComponentDeclarations(sourceFile);
  if (components.length === 0) return false;
  const componentStatements = new Set(components.map((component) => component.statement));
  const hasExport = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  return sourceFile.statements.every((statement) => {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
    if (ts.isExportDeclaration(statement)) return statement.isTypeOnly;
    if (ts.isExportAssignment(statement)) return false;
    if (!hasExport(statement)) return true;
    return (
      ts.isVariableStatement(statement) &&
      componentStatements.has(statement) &&
      statement.declarationList.declarations.every(
        (declaration) => !!declaration.initializer && components.some((c) => c.call === declaration.initializer),
      )
    );
  });
};

/** The packages a module imports at run time: its own imports and re-exports, and the compiler's */
const packagesOf = (sourceFile: ts.SourceFile, code: string): string[] => {
  const specifiers = new Set<string>();
  for (const statement of sourceFile.statements) {
    const specifier =
      (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(statement) && !statement.isTypeOnly)
        ? statement.moduleSpecifier
        : undefined;
    if (specifier && ts.isStringLiteral(specifier) && !/^[./]/.test(specifier.text)) specifiers.add(specifier.text);
  }
  for (const compiled of ['thane/runtime', 'thane/runtime/dom']) {
    if (code.includes(`'${compiled}'`) || code.includes(`"${compiled}"`)) specifiers.add(compiled);
  }
  return [...specifiers];
};

/**
 * `code` (the module as the build compiled it) with the lines that register the module's namespace and
 * its packages' in the page, for a hot update to import them from.
 */
export const hotRegistration = (file: string, code: string, sourceFile: ts.SourceFile, projectRoot: string): string => {
  const self = './' + path.basename(file).replace(/\.ts$/, '.js');
  const packages = packagesOf(sourceFile, code);
  const registrations = [
    `.set(${JSON.stringify(hotModuleKey(file, projectRoot))}, __thane_hot_self)`,
    ...packages.map((specifier, i) => `.set(${JSON.stringify('pkg:' + specifier)}, __thane_hot_pkg${i})`),
  ];
  return [
    code,
    '',
    `import * as __thane_hot_self from ${JSON.stringify(self)};`,
    ...packages.map((specifier, i) => `import * as __thane_hot_pkg${i} from ${JSON.stringify(specifier)};`),
    `(globalThis.__thaneModules ??= new Map())${registrations.join('')};`,
    '',
  ].join('\n');
};

/**
 * The esbuild plugin of a hot update: the changed file and its stylesheets are bundled, and every other
 * import is left to the page: a project module by its key, a package by its specifier. A file the
 * resolver does not know as a module (a JSON file) is bundled too.
 */
export const HotExternalsPlugin = (projectRoot: string): Plugin => ({
  name: 'thane-hot-externals',
  setup(build) {
    const resolveImport = createModuleResolver(projectRoot);
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point' || args.path.endsWith('.css')) return undefined;
      if (/^[./]/.test(args.path) || path.isAbsolute(args.path)) {
        const target = resolveImport(args.path, args.importer);
        return target ? { path: HOT_MODULE_PREFIX + hotModuleKey(target, projectRoot), external: true } : undefined;
      }
      return { path: HOT_PACKAGE_PREFIX + args.path, external: true };
    });
  },
});
