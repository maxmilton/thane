/**
 * Characterisation of the type check (before PB-7): what runProjectTypeCheck and the plugin's
 * onStart resolve or reject with, and what they log, for clean and failing projects, strict and
 * not, with and without a tsconfig.json.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginBuild } from 'esbuild';
import { TSCTypeCheckerPlugin, runProjectTypeCheck } from './tsc-type-checker.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true },
  include: ['./src/**/*.ts', './.thane/types/**/*.d.ts'],
});

let root = '';
const project = (name: string, source: string | null, withConfig = true): string => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  if (withConfig) writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);
  if (source !== null) writeFileSync(join(dir, 'src', 'main.ts'), source);
  return dir;
};

let clean = '';
let failing = '';
let noConfig = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'thane-typecheck-'));
  clean = project('clean', 'export const n: number = 1;\n');
  failing = project('failing', "export const n: number = 'one';\n");
  noConfig = project('no-config', 'export const n = 1;\n', false);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const plain = (value: unknown): string => String(value).replace(/\x1b\[[0-9;]*m/g, '');

/** Run `fn` with console output captured; returns how it settled and every line by stream. */
const capture = async (fn: () => Promise<void>) => {
  const lines = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => lines.log.push(a.map(plain).join(' '));
  console.warn = (...a: unknown[]) => lines.warn.push(a.map(plain).join(' '));
  console.error = (...a: unknown[]) => lines.error.push(a.map(plain).join(' '));
  let outcome = 'resolved';
  try {
    await fn();
  } catch (error) {
    outcome = `rejected: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    Object.assign(console, saved);
  }
  return { outcome, ...lines };
};

/** The plugin's onStart callback, as esbuild would call it. */
const onStartOf = (options: { strict?: boolean; projectRoot?: string }): (() => Promise<void>) => {
  let callback: (() => unknown) | undefined;
  TSCTypeCheckerPlugin(options).setup({ onStart: (cb: () => unknown) => (callback = cb) } as unknown as PluginBuild);
  return async () => {
    await callback?.();
  };
};

const RUNNING = '[type-check] Running TypeScript type check...';
const RULE = '---------------------------------------------------------------';

describe('runProjectTypeCheck', () => {
  test('a clean project resolves and logs only the start line', async () => {
    const r = await capture(() => runProjectTypeCheck({ strict: true, projectRoot: clean }));
    expect(r).toEqual({ outcome: 'resolved', log: [RUNNING], warn: [], error: [] });
  }, 30000);

  test('strict: a type error rejects, after printing the diagnostics', async () => {
    const r = await capture(() => runProjectTypeCheck({ strict: true, projectRoot: failing }));
    expect(r.outcome).toBe('rejected: TypeScript type check failed with 1 error(s)');
    expect(r.log).toEqual([RUNNING]);
    expect(r.warn).toEqual([]);
    expect(r.error.length).toBe(4);
    expect(r.error[0]).toBe('[type-check] Type check failed');
    expect([r.error[1], r.error[3]]).toEqual([RULE, RULE]);
    expect(r.error[2]).toContain('TS2322');
  }, 30000);

  test('not strict: a type error is a warning and resolves', async () => {
    const r = await capture(() => runProjectTypeCheck({ strict: false, projectRoot: failing }));
    expect(r.outcome).toBe('resolved');
    expect(r.log).toEqual([RUNNING]);
    expect(r.warn).toEqual(['[type-check] Type check found issues']);
    expect(r.error.length).toBe(3);
    expect(r.error[1]).toContain('TS2322');
  }, 30000);

  test('no tsconfig.json: an error diagnostic when strict, silence otherwise', async () => {
    const strict = await capture(() => runProjectTypeCheck({ strict: true, projectRoot: noConfig }));
    expect(strict.outcome).toBe('resolved');
    expect(strict.log).toEqual([]);
    expect(strict.error.length).toBe(1);
    expect(strict.error[0]).toContain(`Could not find tsconfig.json in ${noConfig}`);

    const lenient = await capture(() => runProjectTypeCheck({ strict: false, projectRoot: noConfig }));
    expect(lenient).toEqual({ outcome: 'resolved', log: [], warn: [], error: [] });
  }, 30000);
});

describe('TSCTypeCheckerPlugin', () => {
  test('strict: onStart rejects with the type-check error', async () => {
    const r = await capture(onStartOf({ strict: true, projectRoot: failing }));
    expect(r.outcome).toBe('rejected: TypeScript type check failed with 1 error(s)');
    expect(r.error[0]).toBe('[type-check] Type check failed');
  }, 30000);

  test('not strict: onStart resolves', async () => {
    const r = await capture(onStartOf({ strict: false, projectRoot: failing }));
    expect(r.outcome).toBe('resolved');
    expect(r.warn).toEqual(['[type-check] Type check found issues']);
  }, 30000);

  test('strict is the default', async () => {
    const r = await capture(onStartOf({ projectRoot: failing }));
    expect(r.outcome).toBe('rejected: TypeScript type check failed with 1 error(s)');
  }, 30000);

  test('every build runs the check again, after a failure too', async () => {
    const onStart = onStartOf({ strict: true, projectRoot: failing });
    const first = await capture(onStart);
    const second = await capture(onStart);
    expect([first.outcome, second.outcome]).toEqual([
      'rejected: TypeScript type check failed with 1 error(s)',
      'rejected: TypeScript type check failed with 1 error(s)',
    ]);
    expect(second.log).toEqual([RUNNING]);

    const cleanStart = onStartOf({ strict: true, projectRoot: clean });
    await capture(cleanStart);
    expect((await capture(cleanStart)).log).toEqual([RUNNING]);
  }, 60000);
});
