/**
 * Production minification of what Thane owns: compiled HTML templates, component stylesheets
 * and component selectors.
 *
 * All of it happens at compile time, on text the compiler extracted itself and therefore knows
 * the language of. JavaScript is minified by esbuild and by nothing else: the emitted files
 * are never read back, searched or edited, so no library in the bundle can be affected by
 * this plugin, whatever it contains and however the bundle is split.
 *
 * This plugin's one job is the selector plan: before each build it reads the project's own
 * sources and decides which selectors can be renamed (see selector-minifier.ts). The
 * compiler then applies the plan where it writes a selector, and the template and stylesheet
 * minifiers run where the compiler emits a template or a stylesheet.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'esbuild';
import ts from 'typescript';
import { SelectorMap, normalisePath, planSelectorRenames, renameSelectorsInHtml } from './selector-minifier.js';
import { collectFilesRecursively, extractComponentDefinitions, logger, sourceCache } from '../../utils/index.js';
import { collectModuleGraph, createModuleResolver } from '../../utils/module-graph.js';
import type { BuildContext } from '../../types.js';

const NAME = 'minification';

export interface MinificationOptions {
  /** The project being built: only its own sources are read for the selector plan */
  projectRoot: string;
  /** The source index.html */
  htmlPath: string;
  /** The output directory, which may sit inside the project and must not be read as source */
  outDir: string;
  /** The build's entry points: the components they reach are the ones whose selectors are planned */
  entryPoints: string[];
}

const readAll = async (files: string[]): Promise<Array<{ path: string; text: string }>> =>
  Promise.all(files.map(async (file) => ({ path: file, text: await fs.promises.readFile(file, 'utf8') })));

/** The project's TypeScript files, with the parses the build's scan made (the source cache holds them) */
const readParsed = (files: string[]): Promise<Array<{ path: string; text: string; sourceFile: ts.SourceFile }>> =>
  Promise.all(
    files.map(async (file) => {
      const cached = await sourceCache.get(file);
      if (cached) return { path: file, text: cached.source, sourceFile: cached.sourceFile };
      const text = await fs.promises.readFile(file, 'utf8');
      return { path: file, text, sourceFile: sourceCache.parse(file, text) };
    }),
  );

export const MinificationPlugin = (ctx: BuildContext, options: MinificationOptions): Plugin => ({
  name: NAME,
  setup(build) {
    build.onStart(async () => {
      ctx.selectorMap = new SelectorMap();
      if (!ctx.minify) return;

      const projectRoot = path.resolve(options.projectRoot);
      const outPrefix = normalisePath(options.outDir) + path.sep;
      const isSource = (file: string): boolean => !normalisePath(file).startsWith(outPrefix);

      // Every source and stylesheet of the project is read for the names that must stay (an e2e test
      // or a global stylesheet that names a selector keeps it working). Only the components the entry
      // points reach are planned, so a component elsewhere (another app, a test fixture) takes no
      // short name and shifts none.
      const isTs = (file: string): boolean => file.endsWith('.ts') && !file.endsWith('.d.ts');
      const isCss = (file: string): boolean => file.endsWith('.css');
      const paths = (await collectFilesRecursively(projectRoot, (name) => isTs(name) || isCss(name))).filter(isSource);
      const [tsFiles, cssFiles, html, modules] = await Promise.all([
        readParsed(paths.filter(isTs)),
        readAll(paths.filter(isCss)),
        fs.promises.readFile(options.htmlPath, 'utf8').catch(() => ''),
        collectModuleGraph(options.entryPoints, createModuleResolver(projectRoot)),
      ]);

      // Only the project's own components are renamed. Every selector the build knows of is
      // reserved, so a generated name can never be one that a component outside the project uses.
      const reached = new Set(modules.map(normalisePath));
      const selectors = tsFiles
        .filter((file) => reached.has(normalisePath(file.path)))
        .flatMap((file) =>
          extractComponentDefinitions(file.sourceFile, file.path).map((definition) => definition.selector),
        );
      const reserved = Array.from(ctx.componentsBySelector.keys());

      const readExternalStylesheet = (specifier: string, importer: string): string | undefined => {
        const candidates = [
          () => createRequire(importer).resolve(specifier),
          () => path.resolve(path.dirname(importer), specifier),
          () => path.join(projectRoot, 'node_modules', specifier),
        ];
        for (const candidate of candidates) {
          try {
            return fs.readFileSync(candidate(), 'utf8');
          } catch {
            // try the next way of finding it
          }
        }
        return undefined;
      };

      ctx.selectorMap = planSelectorRenames({ selectors, reserved, tsFiles, cssFiles, html, readExternalStylesheet });

      if (ctx.selectorMap.size > 0) {
        const mappings = Array.from(ctx.selectorMap.entries()).map(
          ([original, minified]) => `${original} → ${minified}`,
        );
        logger.info(NAME, `Minifying ${ctx.selectorMap.size} of ${selectors.length} selector(s)`);
        logger.verbose(`${NAME}: ${mappings.join(', ')}`);
      }
    });
  },
});

export const minifySelectorsInHTML = (html: string, ctx: BuildContext): string => {
  if (!ctx.selectorMap || ctx.selectorMap.size === 0) return html;
  return renameSelectorsInHtml(html, ctx.selectorMap);
};
