/**
 * Builds every app in the repository, dev and prod, with the compiled CLI in dist/, and writes
 * the normalised output of each build to `<SNAP_DIR>/app-<name>-<mode>.txt`.
 *
 *   SNAP_DIR=<dir> bun scripts/snapshot/apps.ts   (from the repository root, after `bun run build`)
 *
 * Normally started by `bun run snapshot:output --out <dir>` (scripts/snapshot/output.ts).
 * `apps` and `buildApp` are also used by scripts/size-report.ts.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import { normaliseOutput } from './normalise.ts';

export const repoRoot = resolve(import.meta.dir, '../..');
const cli = join(repoRoot, 'dist/compiler/cli/thane.js');

export interface AppSpec {
  name: string;
  /** Folder the CLI runs in, relative to the repository root. */
  cwd: string;
  entry: string;
  html: string;
  assets?: string;
}

export const apps: AppSpec[] = [
  {
    name: 'e2e-contract',
    cwd: '.',
    entry: './e2e/contract-app/main.ts',
    html: './e2e/contract-app/index.html',
    assets: './e2e/contract-app/assets',
  },
  { name: 'e2e-router', cwd: '.', entry: './e2e/router-app/main.ts', html: './e2e/router-app/index.html' },
  { name: 'e2e-cart', cwd: '.', entry: './e2e/cart-app/main.ts', html: './e2e/cart-app/index.html' },
  { name: 'e2e-hardening', cwd: '.', entry: './e2e/hardening-app/main.ts', html: './e2e/hardening-app/index.html' },
  { name: 'e2e-meta', cwd: '.', entry: './e2e/meta-app/main.ts', html: './e2e/meta-app/index.html' },
  {
    name: 'e2e-browser-error',
    cwd: '.',
    entry: './e2e/browser-error-app/main.ts',
    html: './e2e/browser-error-app/index.html',
  },
  { name: 'example-benchmark', cwd: 'example-apps/benchmark', entry: './main.ts', html: './index.html' },
  { name: 'bench-app', cwd: 'bench/app', entry: './main.ts', html: './index.html' },
  { name: 'bench-nested', cwd: 'bench/app-nested', entry: './main.ts', html: './index.html' },
  {
    name: 'example-store',
    cwd: 'example-apps/store/thane',
    entry: './src/main.ts',
    html: './index.html',
    assets: './src/assets',
  },
];

/**
 * `bun run build` (`tsc -p tsconfig.build.json`), with tsc started directly rather than through
 * the node_modules/.bin shim: Windows Application Control blocks the shim executables that
 * Bun 1.4 writes, and `bun run` then hangs (Bun 1.3) or fails with "bun: unknown error" (Bun 1.4).
 */
export const buildFramework = (): void => {
  const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc');
  const r = Bun.spawnSync([process.execPath, tsc, '-p', 'tsconfig.build.json'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) throw new Error(`tsc -p tsconfig.build.json failed:\n${r.stdout}${r.stderr}`);
};

export type Mode = 'dev' | 'prod';

/** Bun 1.3.4 on Windows panics now and then ("panic(main thread): unreachable") in a build that then passes. */
const BUN_CRASH = 'Bun has crashed';

/**
 * Runs `thane build` for one app into `out` (absolute). Returns the exit code, stderr and how many
 * times the build was repeated because Bun itself crashed (at most twice).
 */
export const buildApp = async (
  app: AppSpec,
  mode: Mode,
  out: string,
): Promise<{ exitCode: number; stderr: string; crashRetries: number }> => {
  let crashRetries = 0;
  for (;;) {
    const r = await buildOnce(app, mode, out);
    if (r.exitCode === 0 || !r.stderr.includes(BUN_CRASH) || crashRetries === 2) return { ...r, crashRetries };
    crashRetries++;
  }
};

const buildOnce = async (app: AppSpec, mode: Mode, out: string): Promise<{ exitCode: number; stderr: string }> => {
  await rm(out, { recursive: true, force: true });
  const args = [
    'build',
    ...(mode === 'prod' ? ['--prod'] : []),
    '--entry',
    app.entry,
    '--out',
    out,
    '--html',
    app.html,
    ...(app.assets ? ['--assets', app.assets] : []),
  ];
  const r = await $`${process.execPath} ${cli} ${args}`.cwd(join(repoRoot, app.cwd)).quiet().nothrow();
  return { exitCode: r.exitCode, stderr: r.stderr.toString() };
};

/** Every emitted .js and .html file under `dir`, in name order, each headed by its name (hash removed). */
const readJs = async (dir: string): Promise<string> => {
  const parts: string[] = [];
  const walk = async (d: string) => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.js') || e.name.endsWith('.html'))
        parts.push(`/* ${e.name.replace(/-[A-Z0-9]{8}(?=\.js$)/, '-HASH')} */\n` + (await readFile(p, 'utf8')));
    }
  };
  await walk(dir);
  return parts.join('\n');
};

if (import.meta.main) {
  const SNAP_DIR = process.env['SNAP_DIR'];
  if (!SNAP_DIR) {
    console.error('Set SNAP_DIR to the snapshot folder (or use: bun run snapshot:output --out <dir>)');
    process.exit(1);
  }
  const tmp = join(repoRoot, '.tmp-snap-apps');
  let failed = 0;
  await mkdir(SNAP_DIR, { recursive: true });
  for (const app of apps) {
    for (const mode of ['dev', 'prod'] as const) {
      const out = join(tmp, `${app.name}-${mode}`);
      const r = await buildApp(app, mode, out);
      const text = r.exitCode === 0 ? await readJs(out) : `BUILD FAILED (${r.exitCode})\n` + r.stderr;
      await writeFile(join(SNAP_DIR, `app-${app.name}-${mode}.txt`), normaliseOutput(text), 'utf8');
      if (r.exitCode !== 0) failed++;
      const retried = r.crashRetries ? ` (repeated ${r.crashRetries}x after a Bun crash)` : '';
      console.log(`  ${app.name.padEnd(20)} ${mode.padEnd(5)} ${r.exitCode === 0 ? 'ok' : 'FAILED'}${retried}`);
    }
  }
  await rm(tmp, { recursive: true, force: true });
  if (failed > 0) console.log(`  ${failed} app build(s) failed; their snapshot holds the error output`);
}
