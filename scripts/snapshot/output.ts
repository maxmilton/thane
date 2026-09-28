/**
 * Writes a compiled-output snapshot set: every build-through unit-test fixture and every app,
 * dev and prod, normalised so that two checkouts of the same source compare equal.
 *
 *   bun run snapshot:output --out <dir> [--no-build]
 *
 * 1. `bun run build` (skip with --no-build), because the apps are built with dist/compiler and
 *    resolve `thane` to dist/runtime.
 * 2. `bun test ./src --preload ./scripts/snapshot/preload.ts` with SNAP_DIR=<dir>:
 *    one `<hash>.txt` per buildAndReadJs() fixture, `<hash>.error.txt` for expected build errors.
 * 3. `bun scripts/snapshot/apps.ts` with SNAP_DIR=<dir>: one `app-<name>-<mode>.txt` per app build.
 *
 * <dir> is emptied first. Compare two sets with `bun run snapshot:compare <a> <b>`.
 * Exits non-zero if a unit test or an app build failed (the files are still written).
 */
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { buildFramework, repoRoot } from './apps.ts';

const USAGE = 'Usage: bun run snapshot:output --out <dir> [--no-build]';

let outArg: string | undefined;
let build = true;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === '--out') outArg = argv[++i];
  else if (arg === '--no-build') build = false;
  else if (arg === '-h' || arg === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`Unknown option ${arg}\n${USAGE}`);
    process.exit(1);
  }
}
if (!outArg) {
  console.error(USAGE);
  process.exit(1);
}
const outDir = resolve(outArg);

// Refuse to empty a folder that does not look like a snapshot set.
if (existsSync(outDir)) {
  const foreign = readdirSync(outDir).filter((f) => !f.endsWith('.txt') || statSync(join(outDir, f)).isDirectory());
  if (foreign.length > 0) {
    console.error(
      `${outDir} holds files that are not snapshots (${foreign.slice(0, 3).join(', ')}); choose another --out`,
    );
    process.exit(1);
  }
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

const run = (cmd: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(cmd, { cwd: repoRoot, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });

if (build) {
  console.log('▶ bun run build');
  buildFramework();
}

// example-apps/benchmark resolves `thane` from the tarball that `bun run test:benchmark` installs.
const installed = join(repoRoot, 'example-apps/benchmark/node_modules/thane/dist');
const listFiles = (root: string, dir = root, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(root, p, out);
    else out.push(relative(root, p));
  }
  return out;
};
const sameTree = (a: string, b: string): boolean => {
  if (!existsSync(a) || !existsSync(b)) return false;
  const filesA = listFiles(a).sort();
  const filesB = listFiles(b).sort();
  if (filesA.join('\n') !== filesB.join('\n')) return false;
  return filesA.every((f) => readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
};
if (!sameTree(join(repoRoot, 'dist'), installed)) {
  console.warn(
    '⚠ example-apps/benchmark has no thane install, or one that differs from dist/: its snapshots reflect that.\n' +
      '  Run `bun run test:benchmark` first when you want them to follow the working tree.',
  );
}

console.log(`▶ bun test ./src --preload ./scripts/snapshot/preload.ts  (SNAP_DIR=${outDir})`);
const tests = run([process.execPath, 'test', './src', '--preload', './scripts/snapshot/preload.ts'], {
  SNAP_DIR: outDir,
});
const testOutput = (tests.stdout.toString() + tests.stderr.toString()).replace(/\r\n/g, '\n');
for (const line of testOutput.split('\n')) {
  if (/^\(fail\)|^\s*\d+ (pass|fail|todo|skip)\b|^\s*[\d,]+ expect\(\) calls|^Ran \d+ tests/.test(line)) {
    console.log(`  ${line.trim()}`);
  }
}

console.log('▶ bun scripts/snapshot/apps.ts');
const appsRun = Bun.spawnSync([process.execPath, 'scripts/snapshot/apps.ts'], {
  cwd: repoRoot,
  env: { ...process.env, SNAP_DIR: outDir },
  stdout: 'inherit',
  stderr: 'inherit',
});

const files = readdirSync(outDir);
const appFiles = files.filter((f) => f.startsWith('app-'));
const errorFiles = files.filter((f) => f.endsWith('.error.txt'));
const failedApps = appFiles.filter((f) => readFileSync(join(outDir, f), 'utf8').startsWith('BUILD FAILED'));
console.log(
  `\n${files.length} snapshot files in ${outDir}: ${files.length - appFiles.length} unit fixtures ` +
    `(${errorFiles.length} expected build errors), ${appFiles.length} app builds` +
    (failedApps.length ? ` (${failedApps.length} failed: ${failedApps.join(', ')})` : ''),
);

if (tests.exitCode !== 0) console.error(`✖ bun test exited with ${tests.exitCode}`);
if (appsRun.exitCode !== 0) console.error(`✖ scripts/snapshot/apps.ts exited with ${appsRun.exitCode}`);
if (tests.exitCode !== 0 || appsRun.exitCode !== 0 || failedApps.length > 0) process.exit(1);
