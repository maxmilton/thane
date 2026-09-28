/**
 * `.css` imports under Thane's own type check (PL-4 step 9, H-49). The type sync writes
 * `.thane/types/client.d.ts`, and the check always adds `.thane/types/**` to the program, so a
 * project type-checks a `.css` import without naming `thane/client` anywhere.
 *
 * Until H-49 that file was a copy of the package's client.d.ts (`declare module '*.css'`). Any
 * other way of including the package file then put the declaration in the program twice, and the
 * check failed with TS2300 (duplicate identifier) unless the project set skipLibCheck: the
 * documented setup, `"types": ["thane/client"]` (docs/getting-started.md), and PL-4 step 9's
 * `/// <reference path>` in the `thane` declarations. Now the generated file is one
 * `/// <reference path>` to the package's client.d.ts, so the declaration exists once.
 *
 * A `types` entry resolves only from an installed package, so the documented setup is stood in for
 * here by a tsconfig that includes the package's client.d.ts itself; the installed-package case is
 * covered by scripts/check-exports.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { runProjectTypeCheck } from './tsc-type-checker.js';
import { createTempProject, removeTempProject, type TempProject } from '../../testing/build-project.js';

const tsconfig = (extra: Record<string, unknown>, include: string[] = []) =>
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
    include: ['./src/**/*.ts', ...include],
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
const typecheck = async (compilerOptions: Record<string, unknown>, include: string[] = []) => {
  project = await createTempProject(MAIN, {
    'src/x.css': '.a { color: red; }\n',
    'tsconfig.json': tsconfig(compilerOptions, include),
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

  test("H-49: the package's client.d.ts included by the tsconfig as well, without skipLibCheck", async () => {
    // What `"types": ["thane/client"]` does from an installed package: the same file, named once more.
    // Temp projects live one level below the repository root, where client.d.ts is.
    expect(await typecheck({ types: [] }, ['../client.d.ts'])).toEqual({ outcome: 'resolved', codes: [] });
  }, 60000);
});
