import fs from 'node:fs';
import type { Plugin } from 'esbuild';
import { PLUGIN_NAME } from '../../utils/index.js';
import { transformCss } from '../minification/css-transform.js';
import type { SelectorMap } from '../minification/selector-minifier.js';

const NAME = PLUGIN_NAME.GLOBAL_CSS_BUNDLER;

export interface GlobalCSSBundlerOptions {
  /** Whether to minify CSS (default: false) */
  minify?: boolean;
  /**
   * The build's selector plan, read per file (it is made in onStart, after this plugin is
   * created). Class selectors are renamed only in the stylesheets the plan itself read, so a
   * stylesheet imported from a package is never renamed in.
   */
  selectorMap?: () => SelectorMap | undefined;
}

export const GlobalCSSBundlerPlugin = (options: GlobalCSSBundlerOptions = {}): Plugin => ({
  name: NAME,
  setup(build) {
    const shouldMinify = options.minify ?? false;

    build.onLoad({ filter: /\.css$/ }, async (args) => {
      try {
        const selectorMap = options.selectorMap?.();
        const cssContent = transformCss(await fs.promises.readFile(args.path, 'utf8'), {
          minify: shouldMinify,
          selectorMap: selectorMap?.hasStylesheet(args.path) ? selectorMap : undefined,
          file: args.path,
        });
        return {
          contents: `export default ${JSON.stringify(cssContent)};`,
          loader: 'ts',
        };
      } catch (error) {
        console.warn(`[${NAME}] CSS file not found: ${args.path}`);
        return {
          contents: `export default '';`,
          loader: 'ts',
        };
      }
    });
  },
});
