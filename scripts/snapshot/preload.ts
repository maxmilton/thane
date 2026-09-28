/**
 * `bun test --preload`: records the normalised output of every buildAndReadJs() fixture.
 *
 *   SNAP_DIR=<dir> bun test ./src --preload ./scripts/snapshot/preload.ts
 *
 * Normally started by `bun run snapshot:output --out <dir>` (scripts/snapshot/output.ts).
 * Replaces buildAndReadJs() from src/compiler/testing/build-project.ts with the same build,
 * run in a project folder named by a hash of the fixture's inputs, so generated ids are the
 * same on every run in this checkout. Each fixture writes `<key>.txt` (emitted JS and
 * index.html) or `<key>.error.txt` (a build that throws; the error is re-thrown, so tests
 * that expect it still pass). Without SNAP_DIR it only swaps the folder name.
 */
import { mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BuildConfig } from '../../src/compiler/cli/types.ts';
import { normaliseOutput } from './normalise.ts';

const SNAP_DIR = process.env['SNAP_DIR'];
const helperPath = resolve(import.meta.dir, '../../src/compiler/testing/build-project.ts');
const original = await import(helperPath);
const { runBuild } = await import(resolve(import.meta.dir, '../../src/compiler/cli/build.ts'));

const INDEX_HTML = '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="app"></div></body></html>';

mock.module(helperPath, () => ({
  ...original,
  buildAndReadJs: async (
    entrySource: string,
    options: { extraFiles?: Record<string, string>; config?: Partial<BuildConfig> } = {},
  ) => {
    const key = createHash('sha1')
      .update(JSON.stringify([entrySource, options.extraFiles ?? {}, options.config ?? {}]))
      .digest('hex')
      .slice(0, 12);
    // Deterministic project folder: generated ids are seeded from the file path
    const root = join(process.cwd(), `.tmp-thane-snap-${key}`);
    await rm(root, { recursive: true, force: true });
    const project = {
      root,
      srcDir: join(root, 'src'),
      outDir: join(root, 'dist'),
      htmlPath: join(root, 'index.html'),
      entryPath: join(root, 'src', 'main.ts'),
    };
    await mkdir(project.srcDir, { recursive: true });
    await writeFile(project.htmlPath, INDEX_HTML, 'utf8');
    await writeFile(project.entryPath, entrySource, 'utf8');
    for (const [rel, contents] of Object.entries(options.extraFiles ?? {})) {
      await mkdir(join(root, rel, '..'), { recursive: true });
      await writeFile(join(root, rel), contents, 'utf8');
    }
    let js: string;
    try {
      await runBuild(original.createTestBuildConfig(project, options.config));
      js = await original.readBuiltJs(project.outDir);
      if (SNAP_DIR) {
        const html = await readFile(join(project.outDir, 'index.html'), 'utf8').catch(() => '');
        await mkdir(SNAP_DIR, { recursive: true });
        await writeFile(join(SNAP_DIR, `${key}.txt`), normaliseOutput(js + '\n/* index.html */\n' + html, key), 'utf8');
      }
    } catch (error) {
      if (SNAP_DIR) {
        await mkdir(SNAP_DIR, { recursive: true });
        await writeFile(join(SNAP_DIR, `${key}.error.txt`), normaliseOutput(String(error), key), 'utf8');
      }
      throw error;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    return js;
  },
}));
