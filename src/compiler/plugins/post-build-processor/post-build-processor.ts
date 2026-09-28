/**
 * Post-Build Processor — orchestrates file copying, compression, HTML templating,
 * dev server, live reload, and console reporting after esbuild completes.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Metafile, Plugin } from 'esbuild';
import { sourceCache, PLUGIN_NAME, consoleColors, logger } from '../../utils/index.js';
import type { BuildContext } from '../../types.js';

import {
  recursivelyCopyAssetsIntoDist,
  watchAndRecursivelyCopyAssetsIntoDist,
  watchFileForChanges,
} from './file-copy.js';
import { gzipDistFiles } from './compression.js';
import { DevServer } from './dev-server.js';
import { collectFileSizes, printAllFileSizes, printTotalSizes } from './console-reporting.js';
import { minifySelectorsInHTML } from '../minification/minification.js';
import { minifyHTML } from '../minification/template-minifier.js';

const NAME = PLUGIN_NAME.POST_BUILD;

export interface PostBuildOptions {
  distDir: string;
  inputHTMLFilePath: string;
  outputHTMLFilePath: string;
  /** Build entry points (e.g. `['./src/main.ts']`). Used to derive hashed output filenames for script injection. */
  entryPoints: string[];
  assetsInputDir?: string | undefined;
  assetsOutputDir?: string | undefined;
  serve?: boolean | undefined;
  isProd?: boolean | undefined;
  useGzip?: boolean | undefined;
  buildContext?: BuildContext | undefined;
  port?: number | undefined;
  open?: boolean | undefined;
  host?: string | undefined;
  emptyOutDir?: boolean | undefined;
  base?: string | undefined;
}

export const PostBuildPlugin = (options: PostBuildOptions): Plugin => {
  const config = options;
  let totalBundleSizeInBytes = 0;
  let fileSizeLog: { fileName: string; sizeInBytes: number }[] = [];
  const cleanupCallbacks = new Set<() => void>();

  const devServer = new DevServer({
    distDir: config.distDir,
    isProd: config.isProd,
    useGzip: config.useGzip,
    port: config.port,
    open: config.open,
    host: config.host,
  });

  let watchersStarted = false;
  let cachedHashedFileNames: Record<string, string> = {};

  /**
   * Inject `<script type="module" src="...">` tags into the `<head>` of the HTML
   * for each hashed entry-point output file. Replaces any manual script references
   * in the source HTML — the compiler is the single source of truth for entry scripts.
   */
  const injectEntryScripts = (html: string, hashedNames: Record<string, string | undefined>): string => {
    const fileNames = Object.values(hashedNames).filter(Boolean) as string[];
    if (fileNames.length === 0) return html;
    // Match indentation of </head> and inject scripts with one level deeper indent
    return html.replace(/([ \t]*)<\/head>/, (_, indent: string) => {
      const basePath = (config.base ?? '/').replace(/\/$/, '');
      const lines = fileNames.map((f) => `${indent}  <script type="module" src="${basePath}/${f}"></script>`);
      return `${lines.join('\n')}\n${indent}</head>`;
    });
  };

  /** The output index.html: relay script (dev server), entry scripts, selector renames, minified in prod. */
  const renderIndexHtml = async (hashedFileNames: Record<string, string | undefined>): Promise<string> => {
    let data = await fs.promises.readFile(config.inputHTMLFilePath, 'utf8');
    if (config.serve && !config.isProd) {
      data = DevServer.injectBrowserRelayScript(data);
    }
    data = injectEntryScripts(data, hashedFileNames);
    if (config.buildContext) {
      data = minifySelectorsInHTML(data, config.buildContext);
    }
    return config.isProd ? minifyHTML(data) : data;
  };

  /**
   * Re-process the HTML template and notify live reload clients.
   * Used by file watchers when index.html or assets change.
   */
  const reprocessAndReloadHTML = async (): Promise<void> => {
    await fs.promises.writeFile(config.outputHTMLFilePath, await renderIndexHtml(cachedHashedFileNames), 'utf8');
    devServer.notifyLiveReloadClients();
  };

  const copyIndexHTMLIntoDistAndStartServer = async (
    hashedFileNames: Record<string, string | undefined>,
  ): Promise<void> => {
    const { outputHTMLFilePath, isProd, serve, useGzip, distDir } = config;
    const updatedData = await renderIndexHtml(hashedFileNames);

    await fs.promises.writeFile(outputHTMLFilePath, updatedData, 'utf8');

    const sizeInBytes = Buffer.byteLength(updatedData, 'utf8');
    totalBundleSizeInBytes += sizeInBytes;
    fileSizeLog.push({ fileName: 'index.html', sizeInBytes });

    if (useGzip) {
      await gzipDistFiles(distDir, isProd);
    }
    const sizes = await collectFileSizes(fileSizeLog, distDir, useGzip);
    printAllFileSizes(sizes);
    printTotalSizes(totalBundleSizeInBytes, sizes, useGzip);

    fileSizeLog.length = 0;

    if (serve && !devServer.isStarted) {
      devServer.start();
    } else if (serve && !isProd) {
      devServer.notifyLiveReloadClients();
    }
  };

  const processMetafileAndUpdateHTML = async (metafile: Metafile): Promise<void> => {
    const { distDir } = config;
    const outputs = metafile.outputs;

    // Entry points arrive relative from a CLI flag and absolute from a config file, while the
    // metafile always reports them relative to the working directory: compare resolved paths.
    const configuredEntries = new Set(config.entryPoints.map((ep) => path.resolve(ep)));

    // Build a map of configured entry basenames → hashed output filenames.
    // Only includes scripts the user explicitly specified via --entry (not code-split chunks).
    const hashedFileNames: Record<string, string> = {};
    for (const [outputPath, info] of Object.entries(outputs)) {
      const fileName = path.basename(outputPath);
      const fullPath = path.join(distDir, fileName);
      let sizeInBytes = info.bytes;
      try {
        const stats = await fs.promises.stat(fullPath);
        sizeInBytes = stats.size;
      } catch (statErr) {
        logger.verbose(`Could not stat ${fullPath}, using metafile size: ${(statErr as Error).message}`);
      }

      totalBundleSizeInBytes += sizeInBytes;
      fileSizeLog.push({ fileName, sizeInBytes });
      if (info.entryPoint && configuredEntries.has(path.resolve(info.entryPoint))) {
        const entryBasename = path.basename(info.entryPoint, path.extname(info.entryPoint));
        hashedFileNames[entryBasename] = fileName;
      }
    }

    cachedHashedFileNames = { ...hashedFileNames };
    await copyIndexHTMLIntoDistAndStartServer(hashedFileNames);
  };

  return {
    name: NAME,
    setup(build) {
      const { distDir } = config;

      build.onStart(async () => {
        sourceCache.clear();

        if (config.emptyOutDir !== false && fs.existsSync(distDir)) {
          // Resolve to an absolute path: Bun 1.4.x on Windows fails recursive rm on "./"-prefixed paths.
          await fs.promises.rm(path.resolve(distDir), { recursive: true });
        }
        await fs.promises.mkdir(distDir, { recursive: true });
      });

      build.onEnd(async (result) => {
        totalBundleSizeInBytes = 0;

        const { assetsInputDir, assetsOutputDir, serve, inputHTMLFilePath } = config;
        if (assetsInputDir && assetsOutputDir) {
          if (serve && !watchersStarted) {
            cleanupCallbacks.add(
              watchAndRecursivelyCopyAssetsIntoDist(assetsInputDir, assetsOutputDir, () => {
                devServer.notifyLiveReloadClients();
              }),
            );
          } else {
            await recursivelyCopyAssetsIntoDist(assetsInputDir, assetsOutputDir);
          }
        }

        if (result.metafile) {
          await processMetafileAndUpdateHTML(result.metafile);
        }

        if (serve && !watchersStarted) {
          cleanupCallbacks.add(
            watchFileForChanges(inputHTMLFilePath, () => {
              console.info(consoleColors.blue, 'index.html changed, reloading...');
              void reprocessAndReloadHTML();
            }),
          );
          watchersStarted = true;
        }
      });

      build.onDispose(() => {
        for (const cleanup of cleanupCallbacks) {
          cleanup();
        }
        cleanupCallbacks.clear();
        devServer.stop();
      });
    },
  };
};
