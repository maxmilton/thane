/**
 * `.css` imports under Thane's own type check (PL-4 step 9). The type sync writes a copy of the
 * package's client.d.ts (`declare module '*.css'`) to `.thane/types/client.d.ts`, and the check
 * always adds `.thane/types/**` to the program, so a project type-checks a `.css` import without
 * naming `thane/client` anywhere.
 *
 * Step 9 tried carrying the declaration through a `/// <reference path>` in the `thane` entry's
 * declarations instead. That puts client.d.ts in every program that imports `thane`, next to the
 * generated copy, and the check fails with TS2300 (duplicate identifier) unless the project sets
 * skipLibCheck. The test below guards against that.
 *
 * The same duplicate already breaks the documented setup, `"types": ["thane/client"]` without
 * skipLibCheck (docs/getting-started.md). A `types` entry resolves only from an installed package,
 * so that case is not tested here (see the PL hand-off note, wave 2).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { runProjectTypeCheck } from './tsc-type-checker.js';
import { createTempProject, removeTempProject, type TempProject } from '../../testing/build-project.js';

const tsconfig = (extra: Record<string, unknown>) =>
  JSON.stringify({
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      lib: ['ESNext', 'DOM'],
      ...extra,
    },
    include: ['./src/**/*.ts'],
  });

const MAIN = [
  "import { signal } from 'thane';",
  "import styles from './x.css';",
  'export const css: string = styles;',
  'export const n = signal(1);',
  '',
].join('\n');

let project: TempProject | null = null;

afterEach(async () => {
  if (project) await removeTempProject(project);
  project = null;
});

/** runProjectTypeCheck (strict) on a project importing `thane` and a stylesheet; returns the outcome and TS codes. */
const typecheck = async (compilerOptions: Record<string, unknown>) => {
  project = await createTempProject(MAIN, {
    'src/x.css': '.a { color: red; }\n',
    'tsconfig.json': tsconfig(compilerOptions),
  });
  const output: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  console.error = (...a: unknown[]) => output.push(a.map(String).join(' '));
  let outcome = 'resolved';
  try {
    await runProjectTypeCheck({ strict: true, projectRoot: project.root });
  } catch (error) {
    outcome = `rejected: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    Object.assign(console, saved);
  }
  return { outcome, codes: [...new Set(output.join('\n').match(/TS\d{4}/g) ?? [])] };
};

describe('.css imports under thane typecheck', () => {
  test('type-check with no thane/client in the tsconfig and without skipLibCheck', async () => {
    // types: [] keeps the repository's own @types (bun, node) out of this program
    expect(await typecheck({ types: [] })).toEqual({ outcome: 'resolved', codes: [] });
  }, 60000);
});
