import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'esbuild';
import {
  SelectorMap,
  applySelectorsToSource,
  countSelectorTokens,
  isMinifiableSelector,
  isSafeToRename,
} from './selector-minifier.js';
import { minifyTemplatesInSource } from './template-minifier.js';
import { logger } from '../../utils/index.js';
import type { BuildContext } from '../../types.js';

const NAME = 'minification';

export const MinificationPlugin = (ctx: BuildContext): Plugin => ({
  name: NAME,
  setup(build) {
    const selectorMap = new SelectorMap();
    build.onStart(() => {
      selectorMap.clear();
      ctx.selectorMap = selectorMap;
    });
    build.onEnd(async (result) => {
      if (!result.outputFiles || result.outputFiles.length === 0) {
        return;
      }

      const startTime = performance.now();

      // Selector renaming and template minification only make sense for code the Thane
      // compiler produced. A chunk built entirely from node_modules (a vendor library) is
      // left byte-for-byte as esbuild emitted it: rewriting a library's strings and template
      // literals can corrupt it.
      const metafileOutputs = result.metafile?.outputs;
      const resolvedOutputs = new Map<string, string[]>();
      if (metafileOutputs) {
        for (const [outputPath, info] of Object.entries(metafileOutputs)) {
          resolvedOutputs.set(path.resolve(outputPath), Object.keys(info.inputs));
        }
      }
      const isVendorOnlyOutput = (outputPath: string): boolean => {
        const inputs = resolvedOutputs.get(path.resolve(outputPath));
        return !!inputs && inputs.length > 0 && inputs.every((input) => input.split(/[\\/]/).includes('node_modules'));
      };
      const shouldProcess = (outputPath: string): boolean =>
        outputPath.endsWith('.js') && !isVendorOnlyOutput(outputPath);

      const decoder = new TextDecoder();
      const sources = new Map<number, string>();
      for (let i = 0; i < result.outputFiles.length; i++) {
        const file = result.outputFiles[i];
        if (file && shouldProcess(file.path)) sources.set(i, decoder.decode(file.contents));
      }
      const sourceTexts = Array.from(sources.values());

      // The selectors are the ones the compiler found in the project, not a guess from the
      // output. One is renamed only if every appearance of it in the output is a place the
      // renamer rewrites, and its short name must not already mean something there.
      const candidates = Array.from(ctx.componentsBySelector.keys()).filter(isMinifiableSelector).sort();
      const skipped: string[] = [];
      for (const selector of candidates) {
        if (isSafeToRename(sourceTexts, selector)) {
          selectorMap.register(
            selector,
            (name) => candidates.includes(name) || sourceTexts.some((text) => countSelectorTokens(text, name) > 0),
          );
        } else if (sourceTexts.some((text) => countSelectorTokens(text, selector) > 0)) {
          skipped.push(selector);
        }
      }

      if (selectorMap.size > 0) {
        logger.info(NAME, `Registered ${selectorMap.size} selector(s) for minification`);
      }
      if (skipped.length > 0) {
        logger.verbose(
          `${NAME}: kept ${skipped.length} selector(s) that also appear in other strings: ${skipped.join(', ')}`,
        );
      }
      let totalSaved = 0;

      for (const [i, originalContent] of sources) {
        const file = result.outputFiles[i]!;
        const originalSize = file.contents.length;
        let minifiedContent = applySelectorsToSource(originalContent, selectorMap);
        minifiedContent = minifyTemplatesInSource(minifiedContent);
        const newContents = new TextEncoder().encode(minifiedContent);
        const savedBytes = originalSize - newContents.length;
        totalSaved += savedBytes;
        result.outputFiles[i] = {
          path: file.path,
          contents: newContents,
          text: minifiedContent,
          hash: file.hash,
        };
      }
      const firstFile = result.outputFiles[0];
      if (!firstFile) return;
      const distDir = path.dirname(firstFile.path);
      await fs.promises.mkdir(distDir, { recursive: true });

      await Promise.all(
        result.outputFiles.map(async (file) => {
          const dir = path.dirname(file.path);
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.writeFile(file.path, file.contents);
        }),
      );

      const elapsed = (performance.now() - startTime).toFixed(2);
      const savedKB = (totalSaved / 1024).toFixed(2);

      if (totalSaved > 0) {
        logger.info(NAME, `Minified ${sources.size} file(s), saved ${savedKB} KB in ${elapsed}ms`);
      }
      if (selectorMap.size > 0) {
        const mappings: string[] = [];
        for (const [original, minified] of selectorMap.entries()) {
          mappings.push(`${original} → ${minified}`);
        }
        logger.info(NAME, `Selector mappings: ${mappings.join(', ')}`);
      }
    });
  },
});

export const minifySelectorsInHTML = (html: string, ctx: BuildContext): string => {
  if (!ctx.selectorMap || ctx.selectorMap.size === 0) return html;
  return applySelectorsToSource(html, ctx.selectorMap);
};
