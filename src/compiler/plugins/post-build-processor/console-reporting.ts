/**
 * Post-Build Processor — Console reporting utilities
 */

import fs from 'node:fs';
import path from 'node:path';
import { consoleColors } from '../../utils/index.js';

/** A file's size, and with `useGzip` the sizes of its `.gz` and `.br` copies when they exist. */
export interface FileSizes {
  fileName: string;
  sizeInBytes: number;
  gzip?: number | undefined;
  brotli?: number | undefined;
}

const getSizeColor = (sizeInBytes: number, maxSize: number): string => {
  const ratio = sizeInBytes / maxSize;
  if (ratio < 0.33) return '\x1b[32m'; // green
  if (ratio < 0.66) return '\x1b[33m'; // yellow
  if (ratio < 0.85) return '\x1b[38;5;208m'; // orange
  return '\x1b[31m'; // red
};

const statIfExists = async (filePath: string): Promise<number | undefined> =>
  fs.existsSync(filePath) ? (await fs.promises.stat(filePath)).size : undefined;

/** Stat each file's compressed copies once, for both the per-file lines and the totals. */
export const collectFileSizes = async (
  fileSizeLog: { fileName: string; sizeInBytes: number }[],
  distDir: string,
  useGzip?: boolean,
): Promise<FileSizes[]> => {
  const sizes: FileSizes[] = [];
  for (const { fileName, sizeInBytes } of fileSizeLog) {
    const filePath = path.join(distDir, fileName);
    sizes.push({
      fileName,
      sizeInBytes,
      gzip: useGzip ? await statIfExists(filePath + '.gz') : undefined,
      brotli: useGzip ? await statIfExists(filePath + '.br') : undefined,
    });
  }
  return sizes;
};

export const printAllFileSizes = (sizes: FileSizes[]): void => {
  const maxSize = Math.max(...sizes.map((f) => f.sizeInBytes));
  const cyanColor = '\x1b[36m';
  const { reset } = consoleColors;

  for (const { fileName, sizeInBytes, gzip, brotli } of sizes) {
    const sizeInKilobytes = sizeInBytes / 1024;
    const sizeColor = getSizeColor(sizeInBytes, maxSize);
    let sizeInfo = `${sizeColor}Size: ${sizeInKilobytes.toFixed(2)} KB${reset}`;
    if (gzip !== undefined) {
      const greenColor = '\x1b[32m';
      sizeInfo += ` ${greenColor}(gzip: ${(gzip / 1024).toFixed(2)} KB`;
      sizeInfo += brotli !== undefined ? `, br: ${(brotli / 1024).toFixed(2)} KB)` : `)`;
      sizeInfo += reset;
    }

    console.info(`${cyanColor}${fileName}${reset}  ${sizeInfo}`);
  }
};

export const printTotalSizes = (totalBundleSizeInBytes: number, sizes: FileSizes[], useGzip?: boolean): void => {
  const totalSizeInKilobytes = totalBundleSizeInBytes / 1024;
  console.info(
    consoleColors.green,
    `=== TOTAL BUNDLE SIZE: ${totalBundleSizeInBytes.toFixed(2)} B (${totalSizeInKilobytes.toFixed(2)} KB) ===`,
  );

  if (useGzip) {
    const totalGzippedSize = sizes.reduce((total, f) => total + (f.gzip ?? 0), 0);
    const totalBrotliSize = sizes.reduce((total, f) => total + (f.brotli ?? 0), 0);
    const totalGzippedKB = totalGzippedSize / 1024;
    const totalBrotliKB = totalBrotliSize / 1024;
    console.info(
      consoleColors.green,
      `=== TOTAL GZIPPED: ${totalGzippedSize.toFixed(2)} B (${totalGzippedKB.toFixed(2)} KB) ===`,
    );
    console.info(
      consoleColors.green,
      `=== TOTAL BROTLI: ${totalBrotliSize.toFixed(2)} B (${totalBrotliKB.toFixed(2)} KB) ===`,
    );
  }

  console.info('');
};
