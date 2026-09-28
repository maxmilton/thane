/**
 * Characterisation of asset copying and the asset watcher (before PB-4).
 *
 * The watcher runs for real on a temporary folder: edits arrive as `change` events, created,
 * moved-in and deleted entries as `rename` events. Each step waits (polling) for the output
 * folder to reach the expected state.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearAllDebounceTimers,
  recursivelyCopyAssetsIntoDist,
  watchAndRecursivelyCopyAssetsIntoDist,
  watchFileForChanges,
} from './file-copy.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'thane-file-copy-'));
});

afterAll(() => {
  clearAllDebounceTimers();
  rmSync(root, { recursive: true, force: true });
});

const waitFor = async (what: string, condition: () => boolean, timeoutMs = 3000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(20);
  }
};

const read = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null);

describe('recursivelyCopyAssetsIntoDist', () => {
  test('copies files and nested folders', async () => {
    const src = join(root, 'copy-src');
    const dest = join(root, 'copy-dest');
    mkdirSync(join(src, 'img', 'icons'), { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'a');
    writeFileSync(join(src, 'img', 'icons', 'b.svg'), '<svg/>');

    await recursivelyCopyAssetsIntoDist(src, dest);

    expect(read(join(dest, 'a.txt'))).toBe('a');
    expect(read(join(dest, 'img', 'icons', 'b.svg'))).toBe('<svg/>');
  });

  test('a missing source folder creates the destination and does not throw', async () => {
    const dest = join(root, 'missing-dest');
    await recursivelyCopyAssetsIntoDist(join(root, 'no-such-folder'), dest);
    expect(existsSync(dest)).toBe(true);
  });
});

describe('watchAndRecursivelyCopyAssetsIntoDist', () => {
  test('a missing source folder is not watched', () => {
    const cleanup = watchAndRecursivelyCopyAssetsIntoDist(join(root, 'nothing'), join(root, 'nothing-dest'));
    cleanup();
    expect(existsSync(join(root, 'nothing-dest'))).toBe(false);
  });

  test('copies at start, then mirrors edits, additions, moves and deletions', async () => {
    const src = join(root, 'watch-src');
    const dest = join(root, 'watch-dest');
    const staging = join(root, 'watch-staging');
    mkdirSync(join(src, 'sub'), { recursive: true });
    mkdirSync(join(staging, 'moved', 'deep'), { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'a1');
    writeFileSync(join(src, 'sub', 'b.txt'), 'b1');
    writeFileSync(join(staging, 'moved', 'deep', 'm.txt'), 'm1');

    let updates = 0;
    const cleanup = watchAndRecursivelyCopyAssetsIntoDist(src, dest, () => updates++);
    try {
      // The initial copy
      await waitFor(
        'initial copy',
        () => read(join(dest, 'a.txt')) === 'a1' && read(join(dest, 'sub', 'b.txt')) === 'b1',
      );

      // An edit (change event)
      writeFileSync(join(src, 'a.txt'), 'a2');
      await waitFor('edited file copied', () => read(join(dest, 'a.txt')) === 'a2');
      await waitFor('onUpdate after the edit', () => updates > 0);

      // A new file, and an edit inside a folder
      writeFileSync(join(src, 'c.txt'), 'c1');
      writeFileSync(join(src, 'sub', 'b.txt'), 'b2');
      await waitFor('new file copied', () => read(join(dest, 'c.txt')) === 'c1');
      await waitFor('nested edit copied', () => read(join(dest, 'sub', 'b.txt')) === 'b2');

      // A folder moved in (rename event): copied recursively
      renameSync(join(staging, 'moved'), join(src, 'moved'));
      await waitFor('moved-in folder copied', () => read(join(dest, 'moved', 'deep', 'm.txt')) === 'm1');

      // A deleted file (rename event) is removed from the output
      rmSync(join(src, 'c.txt'));
      await waitFor('deleted file removed', () => !existsSync(join(dest, 'c.txt')));

      // A folder moved out (rename event) is removed with its contents
      renameSync(join(src, 'moved'), join(staging, 'moved-out'));
      await waitFor('moved-out folder removed', () => !existsSync(join(dest, 'moved')));

      // A deleted folder: its files are removed. Whether the emptied folder goes too depends on
      // the order of the folder's own events (a trailing `change` for a missing path is ignored),
      // so it is not asserted.
      rmSync(join(src, 'sub'), { recursive: true });
      await waitFor('deleted folder emptied', () => !existsSync(join(dest, 'sub', 'b.txt')));

      // Nothing else was touched
      expect(read(join(dest, 'a.txt'))).toBe('a2');
    } finally {
      cleanup();
    }
  }, 20000);
});

describe('watchFileForChanges', () => {
  test('a missing file is not watched', () => {
    let calls = 0;
    const cleanup = watchFileForChanges(join(root, 'no-such.html'), () => calls++);
    cleanup();
    expect(calls).toBe(0);
  });

  test('rapid edits call onChange once, after the debounce', async () => {
    const file = join(root, 'index.html');
    writeFileSync(file, '<p>1</p>');
    let calls = 0;
    const cleanup = watchFileForChanges(file, () => calls++);
    try {
      writeFileSync(file, '<p>2</p>');
      writeFileSync(file, '<p>3</p>');
      writeFileSync(file, '<p>4</p>');
      await waitFor('onChange', () => calls > 0);
      await Bun.sleep(300);
      expect(calls).toBe(1);
    } finally {
      cleanup();
    }
  });
});
