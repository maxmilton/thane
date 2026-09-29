/**
 * The hot updates of a `thane dev` rebuild: when every file that changed is a component file the page
 * can swap, each is bundled on its own, as CommonJS, with its imports left to the page's modules; the
 * page runs them and swaps the components (see plugins/component-precompiler/hot-modules.ts). Null
 * means the page reloads: another kind of file changed, nothing did, or a bundle failed.
 */
import { build } from 'esbuild';
import type { BuildContext } from '../types.js';
import { ComponentPrecompilerPlugin } from '../plugins/component-precompiler/component-precompiler.js';
import { GlobalCSSBundlerPlugin } from '../plugins/global-css-bundler/global-css-bundler.js';
import { HotExternalsPlugin, hotModuleKey } from '../plugins/component-precompiler/hot-modules.js';
import { logger } from '../utils/index.js';

/** One changed file, compiled for the page: its module key and its code */
export interface HotUpdate {
  key: string;
  code: string;
}

export interface HotUpdateOptions {
  buildContext: BuildContext;
  /** The build's constants and browser targets, which the updates are compiled with too */
  define: Record<string, string>;
  target: string[];
}

export const buildHotUpdates = async (options: HotUpdateOptions): Promise<HotUpdate[] | null> => {
  const { buildContext } = options;
  const changed = [...(buildContext.hot?.changed ?? [])];
  if (changed.length === 0 || changed.some(([, swappable]) => !swappable)) return null;
  try {
    const updates: HotUpdate[] = [];
    for (const [file] of changed) {
      const result = await build({
        absWorkingDir: process.cwd(),
        entryPoints: [file],
        bundle: true,
        write: false,
        format: 'cjs',
        platform: 'browser',
        target: options.target,
        define: options.define,
        logLevel: 'silent',
        plugins: [
          ComponentPrecompilerPlugin(buildContext, { hotUpdate: true }),
          GlobalCSSBundlerPlugin(),
          HotExternalsPlugin(buildContext.projectRoot),
        ],
      });
      updates.push({ key: hotModuleKey(file, buildContext.projectRoot), code: result.outputFiles[0]!.text });
    }
    logger.info('hot', `Updated ${updates.map((update) => update.key).join(', ')}`);
    return updates;
  } catch (error) {
    logger.warn('hot', `A hot update failed, so the page reloads: ${error instanceof Error ? error.message : error}`);
    return null;
  }
};
