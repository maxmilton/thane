/**
 * Golden matrix of CLI option resolution (F0-2 item 5, before CL-1 and CL-5).
 *
 * `resolveCLIOptions(args)` is run for every flag `parseArgs` knows, with and without a value,
 * plus repeated flags, negation pairs in both orders, bare value flags followed by another flag,
 * commands, unknown flags and odd values. Each row runs in three working directories: without a
 * config file, with a `thane.config.json` that sets every option (booleans true), and with a
 * `thane.config.jsonc` that sets every option differently (booleans false). All three also hold
 * `alt.config.json` for `--config`.
 *
 * The golden file stores, per directory, the result for no arguments (`baseline`) and, per row,
 * only what differs from it (`"<absent>"` for a key that disappears) plus any warning printed.
 * Paths are written relative to `<cwd>` with forward slashes.
 *
 * To regenerate after an intended change: `UPDATE_GOLDEN=1 bun test ./src/compiler/cli/cli-matrix.test.ts`,
 * then `bunx prettier --write src/compiler/cli/cli-matrix.golden.json`, and review the diff.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCLIOptions } from './cli-common.js';

const GOLDEN = join(import.meta.dir, 'cli-matrix.golden.json');

const CONFIG_TRUE = {
  prod: true,
  gzip: true,
  app: 'cfg-app',
  entry: './cfg/main.ts',
  outDir: './cfg-dist',
  assetsDir: './cfg-assets',
  html: './cfg/index.html',
  dropConsole: true,
  dropDebugger: true,
  sourcemap: true,
  strictTypeCheck: true,
  port: 5000,
  open: true,
  host: 'cfg-host',
  base: '/cfg/',
  target: ['es2021'],
  hashFileNames: true,
  define: { __CFG__: '"1"' },
  envPrefix: 'CFG_',
  emptyOutDir: true,
  splitting: true,
  legalComments: 'linked',
  analyze: true,
  notAnOption: 1,
  commands: {
    build: { base: '/cfg-build/' },
    dev: { port: 5001, entry: './cfg/dev.ts', prod: true },
    serve: { host: true },
  },
};

const CONFIG_FALSE_JSONC = `{
  // every boolean false, every value different from the other config
  "prod": false,
  "gzip": false,
  "app": "cfg2-app",
  "entry": "./cfg2/main.ts",
  "outDir": "./cfg2-dist",
  "assetsDir": "./cfg2-assets",
  "html": "./cfg2/index.html",
  "dropConsole": false,
  "dropDebugger": false,
  "sourcemap": false,
  "strictTypeCheck": false,
  "port": 6000,
  "open": false,
  "host": "cfg2-host",
  "base": "/cfg2/",
  "target": ["es2019", "firefox100"],
  "hashFileNames": false,
  "define": {},
  "envPrefix": "CFG2_",
  "emptyOutDir": false,
  "splitting": false,
  "legalComments": "external",
  "analyze": false,
  /* per-command overrides */
  "commands": { "build": { "sourcemap": true }, "serve": { "port": 6001 } },
}
`;

const ALT_CONFIG = { entry: './alt/main.ts', port: 7000, prod: true, commands: { build: { outDir: './alt-dist' } } };

const VALUE_FLAGS: Record<string, string> = {
  '--app': 'cli-app',
  '--entry': './cli/main.ts',
  '--out': './cli-dist',
  '--assets': './cli-assets',
  '--html': './cli/index.html',
  '--config': './alt.config.json',
  '--port': '3001',
  '--host': 'cli-host',
  '--base': '/cli/',
  '--target': 'es2020, chrome100,,',
  '--env-prefix': 'CLI_',
  '--legal-comments': 'eof',
};

const BOOLEAN_FLAGS = [
  '--prod',
  '-p',
  '--gzip',
  '--drop-console',
  '--no-drop-console',
  '--drop-debugger',
  '--no-drop-debugger',
  '--sourcemap',
  '--no-sourcemap',
  '--strict-type-check',
  '--open',
  '--no-open',
  '--hash-file-names',
  '--no-hash-file-names',
  '--empty-out-dir',
  '--no-empty-out-dir',
  '--splitting',
  '--no-splitting',
  '--analyze',
  '--no-analyze',
  '--verbose',
  '-V',
  '--quiet',
  '-q',
  '--help',
  '-h',
  '--version',
  '-v',
];

const NEGATION_PAIRS = [
  'drop-console',
  'drop-debugger',
  'sourcemap',
  'open',
  'hash-file-names',
  'empty-out-dir',
  'splitting',
  'analyze',
];

const rows = (): string[][] => {
  const all: string[][] = [[]];
  for (const [flag, value] of Object.entries(VALUE_FLAGS)) {
    all.push([flag, value], [flag], [flag, '--prod'], [flag, '']);
  }
  all.push(
    ['--port', '1', '--port', '2'],
    ['--entry', './a.ts', '--entry', './b.ts'],
    ['--target', 'es2020', '--target', 'es2022'],
    ['--config', './missing.json'],
    ['--port', 'abc'],
    ['--port', '0'],
    ['--host', 'true'],
    ['--legal-comments', 'bogus'],
  );
  for (const flag of BOOLEAN_FLAGS) all.push([flag], [flag, 'stray']);
  all.push(['--prod', '--prod']);
  for (const name of NEGATION_PAIRS) all.push([`--${name}`, `--no-${name}`], [`--no-${name}`, `--${name}`]);
  all.push(['--verbose', '--quiet'], ['--quiet', '--verbose'], ['-V', '-q'], ['-q', '-V']);
  all.push(
    ['dev'],
    ['serve'],
    ['types'],
    ['typecheck'],
    ['dev', '--prod'],
    ['serve', '--prod'],
    ['build', 'dev'],
    ['--entry', 'dev'],
    ['--prod', 'serve'],
    ['--port', '1', 'dev'],
    ['stray'],
  );
  all.push(
    ['--nope'],
    ['-x'],
    ['-P'],
    ['--nope', 'value'],
    ['-xyz'],
    ['---x'],
    ['--app', '--nope'],
    ['--port', '--port', '--nope'],
    ['--entry', '--app', '--zzz'],
    ['--prod', '--nope', '--gzip'],
  );
  return all;
};

const rowKey = (args: string[]) =>
  args.length === 0 ? '(no arguments)' : args.map((a) => (a === '' ? "''" : a)).join(' ');

const states = ['no config file', 'thane.config.json', 'thane.config.jsonc'] as const;
type State = (typeof states)[number];

let root = '';
const dirs = {} as Record<State, string>;
const originalCwd = process.cwd();

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'thane-cli-matrix-')));
  for (const [i, state] of states.entries()) {
    const dir = join(root, `s${i}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'alt.config.json'), JSON.stringify(ALT_CONFIG));
    if (state === 'thane.config.json') writeFileSync(join(dir, 'thane.config.json'), JSON.stringify(CONFIG_TRUE));
    if (state === 'thane.config.jsonc') writeFileSync(join(dir, 'thane.config.jsonc'), CONFIG_FALSE_JSONC);
    dirs[state] = dir;
  }
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON-safe form of a resolved result: paths relative to `<cwd>`, NaN spelled out, undefined keys dropped. */
const normalise = (value: unknown, cwd: string): Json => {
  if (typeof value === 'number' && Number.isNaN(value)) return '<NaN>';
  if (typeof value === 'string') {
    let s = value;
    for (const form of [cwd, cwd.replace(/\\/g, '/')]) s = s.split(form).join('<cwd>');
    return s.replace(/\\/g, '/');
  }
  if (Array.isArray(value)) return value.map((v) => normalise(v, cwd));
  if (value && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalise(v, cwd);
    }
    return out;
  }
  return value as Json;
};

/** The resolved options, or `{ "(error)": message }` when resolving throws (H-24: `--port abc`). */
const resolveIn = (state: State, args: string[]): { result: Json; warnings: string[] } => {
  process.chdir(dirs[state]);
  const cwd = process.cwd();
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const warnings = () => warn.mock.calls.map((call) => call.map(String).join(' '));
  try {
    return { result: normalise(resolveCLIOptions(args), cwd), warnings: warnings() };
  } catch (error) {
    return { result: { '(error)': error instanceof Error ? error.message : String(error) }, warnings: warnings() };
  } finally {
    warn.mockRestore();
    process.chdir(originalCwd);
  }
};

const delta = (baseline: { [key: string]: Json }, result: { [key: string]: Json }) => {
  const out: { [key: string]: Json } = {};
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(result)])) {
    if (!(key in result)) out[key] = '<absent>';
    else if (JSON.stringify(baseline[key]) !== JSON.stringify(result[key])) out[key] = result[key]!;
  }
  return out;
};

const computeMatrix = () => {
  const matrix: { [state: string]: { baseline: Json; rows: { [row: string]: Json } } } = {};
  for (const state of states) {
    const baseline = resolveIn(state, []);
    expect(baseline.warnings).toEqual([]);
    const base = baseline.result as { [key: string]: Json };
    const rowResults: { [row: string]: Json } = {};
    for (const args of rows().slice(1)) {
      const { result, warnings } = resolveIn(state, args);
      const r = result as { [key: string]: Json };
      const d = '(error)' in r ? { ...r } : delta(base, r);
      if (warnings.length > 0) d['(warnings)'] = warnings;
      rowResults[rowKey(args)] = d;
    }
    matrix[state] = { baseline: base, rows: rowResults };
  }
  return matrix;
};

/** One row per line, so the golden file reads as a table. */
const stringify = (matrix: ReturnType<typeof computeMatrix>): string => {
  const parts = Object.entries(matrix).map(([state, { baseline, rows: rowResults }]) => {
    const lines = Object.entries(rowResults).map(
      ([key, value]) => `      ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
    );
    return `  ${JSON.stringify(state)}: {\n    "baseline": ${JSON.stringify(baseline)},\n    "rows": {\n${lines.join(',\n')}\n    }\n  }`;
  });
  return `{\n${parts.join(',\n')}\n}\n`;
};

test('resolveCLIOptions matches the golden matrix', () => {
  const matrix = computeMatrix();
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(GOLDEN, stringify(matrix));
  if (!existsSync(GOLDEN)) throw new Error(`Missing ${GOLDEN}; run with UPDATE_GOLDEN=1 to create it`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  for (const state of states) {
    expect(matrix[state]!.baseline).toEqual(golden[state].baseline);
    for (const [row, value] of Object.entries(matrix[state]!.rows)) {
      expect({ state, row, value }).toEqual({ state, row, value: golden[state].rows[row] });
    }
    expect(Object.keys(matrix[state]!.rows)).toEqual(Object.keys(golden[state].rows));
  }
});
