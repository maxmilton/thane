/**
 * Bundle the TypeScript plugin (src/ts-plugin) into one CommonJS file, dist/ts-plugin/index.cjs.
 *
 * tsserver loads a plugin with require(), and the module it gets must be the plugin's init function.
 * TypeScript itself stays external: the plugin is handed the TypeScript that tsserver runs on, and the
 * rewrite parses with whichever one resolves.
 */
import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

await build({
  entryPoints: [resolve(root, 'src/ts-plugin/index.ts')],
  outfile: resolve(root, 'dist/ts-plugin/index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['typescript'],
  logLevel: 'warning',
  // The default export is the module itself, as tsserver expects
  footer: { js: 'module.exports = module.exports.default;' },
});
