/**
 * Post-Build Processor — Compression utilities
 */

import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { brotliCompress, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import { consoleColors } from '../../utils/index.js';

const brotliCompressAsync = promisify(brotliCompress);

/** Compress `content` the way both the `.gz`/`.br` files and the dev server's responses are compressed. */
export const compress = async (
  content: Uint8Array<ArrayBuffer>,
  encoding: 'br' | 'gzip',
  isProd?: boolean,
): Promise<Uint8Array<ArrayBuffer>> => {
  // Gzip compression using Bun's native API
  if (encoding === 'gzip') return Bun.gzipSync(content, { level: 9 });

  // Brotli compression using node:zlib (Bun doesn't have a native brotli API yet)
  return brotliCompressAsync(content, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_QUALITY]: isProd ? 11 : 4,
      [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
      [zlibConstants.BROTLI_PARAM_LGBLOCK]: 0,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: content.length,
    },
  });
};

export const gzipDistFiles = async (distDir: string, isProd?: boolean): Promise<void> => {
  const compressFile = async (filePath: string): Promise<void> => {
    const content = await Bun.file(filePath).bytes();
    await Bun.write(filePath + '.gz', await compress(content, 'gzip', isProd));
    await Bun.write(filePath + '.br', await compress(content, 'br', isProd));
  };

  const processDirectory = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        await processDirectory(fullPath);
      } else if (entry.isFile() && !entry.name.endsWith('.gz') && !entry.name.endsWith('.br')) {
        const ext = extname(entry.name).toLowerCase();
        const compressibleExtensions = ['.html', '.js', '.css', '.json', '.svg', '.txt', '.xml'];

        if (compressibleExtensions.includes(ext)) {
          await compressFile(fullPath);
        }
      }
    }
  };

  console.info(consoleColors.blue, 'Compressing files with gzip and brotli...');
  await processDirectory(distDir);
  console.info(consoleColors.green, 'Compression complete');
};
