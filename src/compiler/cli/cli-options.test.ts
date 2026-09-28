/**
 * Characterisation of CLI option handling that the golden matrix (cli-matrix.test.ts) does not
 * reach (before CL-1): the help text verbatim, arguments named like Object.prototype members,
 * config files with unusual value shapes, and a repeated --config.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, printHelp, resolveCLIOptions } from './cli-common.js';

const originalCwd = process.cwd();
let root = '';

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'thane-cli-options-')));
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

let dirCount = 0;
/** Resolve `args` in a fresh directory holding the given files; returns the result and any warnings. */
const resolveWith = (files: Record<string, string>, args: string[]) => {
  const dir = join(root, `d${dirCount++}`);
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  process.chdir(dir);
  try {
    const result = resolveCLIOptions(args);
    return { dir, result, warnings: warn.mock.calls.map((c) => c.join(' ')) };
  } finally {
    process.chdir(originalCwd);
    warn.mockRestore();
  }
};

const unknown = (flag: string) => `Warning: Unknown flag '${flag}'. Run 'thane --help' to see available options.`;

test('help text is unchanged', () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    printHelp();
    expect(log.mock.calls.length).toBe(1);
    const golden = readFileSync(join(import.meta.dir, 'cli-help.golden.txt'), 'utf8');
    expect(log.mock.calls[0]![0]).toBe(golden);
  } finally {
    log.mockRestore();
  }
});

describe('arguments named like Object.prototype members', () => {
  for (const arg of ['--constructor', '--toString', '--__proto__', '--hasOwnProperty', '-c']) {
    test(`${arg} is an unknown flag`, () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const opts = parseArgs([arg]);
        expect(warn.mock.calls.map((c) => c.join(' '))).toEqual([unknown(arg)]);
        expect(opts).toEqual(parseArgs([]));
        expect(Object.keys(opts).sort()).toEqual(['command', 'gzip', 'logLevel', 'prod', 'serve']);
      } finally {
        warn.mockRestore();
      }
    });
  }
  for (const arg of ['constructor', 'toString', '__proto__', 'valueOf']) {
    test(`${arg} is a stray positional`, () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const opts = parseArgs([arg]);
        expect(warn).not.toHaveBeenCalled();
        expect(opts).toEqual(parseArgs([]));
      } finally {
        warn.mockRestore();
      }
    });
  }
});

describe('config files', () => {
  test('null values are skipped; false, 0 and empty strings are kept', () => {
    const cfg = {
      prod: null,
      gzip: false,
      port: 0,
      host: '',
      base: null,
      entry: '',
      outDir: null,
      target: [],
      define: {},
      envPrefix: '',
      splitting: false,
      logLevel: 'verbose',
      configPath: './elsewhere.json',
      exitRequested: 'help',
      serve: true,
      command: 'dev',
    };
    const { dir, result, warnings } = resolveWith({ 'thane.config.json': JSON.stringify(cfg) }, []);
    expect(warnings).toEqual([]);
    expect(result).toEqual({
      command: 'build',
      prod: false,
      gzip: false,
      serve: false,
      logLevel: 'normal',
      port: 0,
      host: '',
      entry: '',
      target: [],
      define: {},
      envPrefix: '',
      splitting: false,
      configPath: join(dir, 'thane.config.json'),
    });
  });

  test('per-command sections of any shape', () => {
    const cfg = {
      base: '/top/',
      commands: { build: 'x', dev: 5, serve: [1], types: null, typecheck: { base: '/tc/' } },
    };
    const files = { 'thane.config.json': JSON.stringify(cfg) };
    for (const command of ['build', 'dev', 'serve', 'types']) {
      expect(resolveWith(files, [command]).result.base).toBe('/top/');
    }
    expect(resolveWith(files, ['typecheck']).result.base).toBe('/tc/');
  });

  test('commands that is not an object', () => {
    for (const commands of ['build', 3, null, []]) {
      const { result } = resolveWith({ 'thane.config.json': JSON.stringify({ port: 1, commands }) }, []);
      expect(result.port).toBe(1);
    }
  });

  test('per-command define replaces the top-level define', () => {
    const cfg = { define: { A: '1', B: '2' }, commands: { build: { define: { C: '3' } } } };
    const { result } = resolveWith({ 'thane.config.json': JSON.stringify(cfg) }, []);
    expect(result.define).toEqual({ C: '3' });
  });

  test('config paths resolve against the config file; --config against the working directory', () => {
    const cfg = { entry: './e.ts', outDir: 'out', assetsDir: '/abs/assets', html: '' };
    const { dir, result } = resolveWith({ 'thane.config.json': '{}', 'other.json': JSON.stringify(cfg) }, [
      '--config',
      'other.json',
    ]);
    expect(result.configPath).toBe(join(dir, 'other.json'));
    expect(result.entry).toBe(join(dir, 'e.ts'));
    expect(result.outDir).toBe(join(dir, 'out'));
    expect(result.assetsDir).toBe('/abs/assets');
    expect(result.html).toBe('');
  });

  test('--config twice: the last one is loaded', () => {
    const files = { 'a.json': JSON.stringify({ port: 1 }), 'b.json': JSON.stringify({ port: 2 }) };
    const { dir, result } = resolveWith(files, ['--config', 'a.json', '--config', 'b.json']);
    expect(result.port).toBe(2);
    expect(result.configPath).toBe(join(dir, 'b.json'));
  });

  test('a stray value after a boolean flag with a config file', () => {
    const { result, warnings } = resolveWith({ 'thane.config.json': JSON.stringify({ port: 1 }) }, [
      '--gzip',
      'x',
      '--no-open',
      '--nope',
    ]);
    expect(warnings).toEqual([unknown('--nope')]);
    expect(result.gzip).toBe(true);
    expect(result.open).toBe(false);
    expect(result.port).toBe(1);
  });
});
