/**
 * Post-Build Processor — File copying utilities
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/index.js';

type WatchCleanup = () => void;

/** A path to leave out of a copy, relative to the copied folder, with `/` separators. */
export type CopySkip = (relativePath: string) => boolean;

export const recursivelyCopyAssetsIntoDist = async (
  src: string,
  dest: string,
  skip?: CopySkip,
  relativeDir = '',
): Promise<void> => {
  await fs.promises.mkdir(dest, { recursive: true });

  try {
    const entries = await fs.promises.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      const relativePath = relativeDir + entry.name;
      if (skip?.(relativePath)) continue;

      if (entry.isDirectory()) {
        await recursivelyCopyAssetsIntoDist(srcPath, destPath, skip, relativePath + '/');
      } else {
        await fs.promises.copyFile(srcPath, destPath);
      }
    }
  } catch (error) {
    logger.verbose(`[file-copy] Failed to copy assets from ${src}: ${error instanceof Error ? error.message : error}`);
  }
};

/**
 * Debounce timer map for filesystem watcher events.
 * Cleaned up on process exit to avoid resource leaks in watch mode.
 */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 100;

/** Clear all pending debounce timers — called on process exit. */
export function clearAllDebounceTimers(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}

export const watchAndRecursivelyCopyAssetsIntoDist = (
  src: string,
  dest: string,
  onUpdate?: () => void,
  skip?: CopySkip,
): WatchCleanup => {
  if (!fs.existsSync(src)) {
    return () => {};
  }

  recursivelyCopyAssetsIntoDist(src, dest, skip);

  // One path is synchronised at a time, in the order its debounce ends: a deleted folder and a file
  // inside it are reported together, and removing both at once can fail on Windows
  let pending: Promise<void> = Promise.resolve();

  const sync = async (filename: string): Promise<void> => {
    const relativePath = filename.split(path.sep).join('/');
    if (skip?.(relativePath)) return;
    const srcPath = path.join(src, filename);
    const destPath = path.join(dest, filename);
    try {
      // A path that has gone is removed from the output, whichever event came last: the debounce
      // keeps one, and Windows can report a deleted folder's `change` after its `rename`
      const stat = await fs.promises.lstat(srcPath).catch(() => null);
      if (stat?.isDirectory()) {
        await recursivelyCopyAssetsIntoDist(srcPath, destPath, skip, relativePath + '/');
      } else if (stat) {
        await fs.promises.copyFile(srcPath, destPath);
      } else {
        // Windows can hold a just-deleted entry for a moment (EBUSY, ENOTEMPTY, EPERM)
        await fs.promises.rm(destPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
      onUpdate?.();
    } catch (error) {
      // Race conditions during rapid file changes
      logger.verbose(`[file-copy] Watcher error for ${filename}: ${error instanceof Error ? error.message : error}`);
    }
  };

  const watcher = fs.watch(src, { recursive: true }, (_eventType: string, filename: string | null) => {
    if (!filename) return;

    // Debounce rapid saves to avoid redundant rebuilds
    const existingTimer = debounceTimers.get(filename);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    debounceTimers.set(
      filename,
      setTimeout(() => {
        debounceTimers.delete(filename);
        pending = pending.then(() => sync(filename));
      }, DEBOUNCE_MS),
    );
  });

  return () => {
    watcher.close();
  };
};

/**
 * Watch a single file for changes with debouncing
 */
export const watchFileForChanges = (filePath: string, onChange: () => void): WatchCleanup => {
  if (!fs.existsSync(filePath)) {
    return () => {};
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = fs.watch(filePath, (eventType: string) => {
    if (eventType !== 'change') return;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange();
    }, DEBOUNCE_MS);
  });

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    watcher.close();
  };
};
