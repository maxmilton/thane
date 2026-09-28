/**
 * One record per phase of the simplification round's benchmark programme.
 *
 *   bun scripts/phase-report.ts <label> [--verify-log <file>] [--size-json <file>]
 *                                        [--previous <phase.json>] [--out <file>] [--runs <n>] [--no-build]
 *
 * Collects, for the checked-out commit:
 *  - the commit (hash, subject, whether the tree is dirty);
 *  - line counts (`wc -l`) of src/ outside tests: runtime, compiler (without src/compiler/testing/)
 *    and contracts, plus the unit-test lines per area. Test files are *.test.ts / *.spec.ts and
 *    anything under a testing/ folder;
 *  - unit-test and e2e counts parsed from a `bun run verify` log (--verify-log; the last bun test
 *    summary and the last Playwright run in the log);
 *  - the size report: read from --size-json (a `bun run size --json` file), otherwise measured now;
 *  - the median of <n> (default 5) `thane build --prod` times of the contract e2e app, after one
 *    untimed warm-up build.
 *
 * Writes the record as JSON (default bench/results/phase-<label>.json) and prints a Markdown
 * rendering for results.md. With --previous, the Markdown shows the change against that record.
 * Take it with nothing else running on the machine: the build times are wall-clock times.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { measureSizes, type SizeReport } from './size-report.ts';
import { apps, buildApp, buildFramework, repoRoot } from './snapshot/apps.ts';

interface LineCounts {
  runtime: number;
  compiler: number;
  contracts: number;
  /** runtime + compiler + contracts */
  total: number;
}

interface UnitCounts {
  pass: number;
  fail: number;
  todo: number;
  skip: number;
  files: number | null;
  expects: number | null;
}

interface E2eCounts {
  total: number | null;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  didNotRun: number;
  interrupted: number;
}

export interface PhaseRecord {
  label: string;
  generatedAt: string;
  bun: string;
  commit: { hash: string; short: string; subject: string; dirty: boolean };
  lines: LineCounts;
  testLines: LineCounts;
  tests: { log: string | null; unit: UnitCounts | null; e2e: E2eCounts | null };
  size: SizeReport;
  buildTime: { app: string; mode: 'prod'; warmupMs: number; runsMs: number[]; medianMs: number };
}

const USAGE =
  'Usage: bun scripts/phase-report.ts <label> [--verify-log <file>] [--size-json <file>] ' +
  '[--previous <phase.json>] [--out <file>] [--runs <n>] [--no-build]';

const git = (args: string[]) => {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

const isTestFile = (rel: string) =>
  /\.(test|spec)\.ts$/.test(rel) || rel.split('/').includes('testing') || rel.split('/').includes('__tests__');

function countLines(): { lines: LineCounts; testLines: LineCounts } {
  const lines = { runtime: 0, compiler: 0, contracts: 0, total: 0 };
  const testLines = { runtime: 0, compiler: 0, contracts: 0, total: 0 };
  for (const area of ['runtime', 'compiler', 'contracts'] as const) {
    const root = join(repoRoot, 'src', area);
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) {
          const rel = relative(join(repoRoot, 'src'), p).replace(/\\/g, '/');
          const n = (readFileSync(p, 'utf8').match(/\n/g) ?? []).length; // what `wc -l` counts
          // src/compiler/testing/ is a test helper: neither framework code nor a test file
          if (rel.startsWith('compiler/testing/')) continue;
          if (isTestFile(rel)) testLines[area] += n;
          else lines[area] += n;
        }
      }
    };
    walk(root);
  }
  lines.total = lines.runtime + lines.compiler + lines.contracts;
  testLines.total = testLines.runtime + testLines.compiler + testLines.contracts;
  return { lines, testLines };
}

// ---------------------------------------------------------------------------
// Test counts from a verify log
// ---------------------------------------------------------------------------

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

export function parseVerifyLog(text: string): { unit: UnitCounts | null; e2e: E2eCounts | null } {
  const lines = stripAnsi(text).replace(/\r\n?/g, '\n').split('\n');

  // bun test prints " 470 pass", " 0 fail", " 1170 expect() calls", "Ran 470 tests across 35 files."
  let unit: UnitCounts | null = null;
  const ranIdx = lines
    .map((l, i) => (/^Ran \d+ tests? across \d+ files?/.test(l.trim()) ? i : -1))
    .filter((i) => i >= 0);
  const lastRan = ranIdx.at(-1);
  if (lastRan !== undefined) {
    unit = { pass: 0, fail: 0, todo: 0, skip: 0, files: null, expects: null };
    const ran = /across (\d+) files?/.exec(lines[lastRan]!);
    unit.files = ran ? Number(ran[1]) : null;
    // The counts sit in the few lines just above "Ran …"
    for (let i = lastRan - 1; i >= Math.max(0, lastRan - 8); i--) {
      const l = lines[i]!.trim();
      const m = /^(\d+) (pass|fail|todo|skip)$/.exec(l);
      if (m) unit[m[2] as 'pass' | 'fail' | 'todo' | 'skip'] = Number(m[1]);
      const e = /^([\d,]+) expect\(\) calls?$/.exec(l);
      if (e) unit.expects = Number(e[1]!.replace(/,/g, ''));
    }
  }

  // Playwright's list reporter: "Running 185 tests using 8 workers", then per-test lines, then
  // "  17 failed", "  1 flaky", "  3 skipped", "  168 passed (40.1s)" (only the non-zero ones).
  let e2e: E2eCounts | null = null;
  const runIdx = lines
    .map((l, i) => (/^Running \d+ tests? using \d+ workers?/.test(l.trim()) ? i : -1))
    .filter((i) => i >= 0);
  const lastRun = runIdx.at(-1);
  const summaryRe = /^(\d+) (passed|failed|flaky|skipped|did not run|interrupted)\b/;
  const start = lastRun ?? lines.findIndex((l) => summaryRe.test(l.trim()));
  if (start !== undefined && start >= 0) {
    const counts: E2eCounts = { total: null, passed: 0, failed: 0, flaky: 0, skipped: 0, didNotRun: 0, interrupted: 0 };
    if (lastRun !== undefined) counts.total = Number(/^Running (\d+)/.exec(lines[lastRun]!.trim())![1]);
    let found = false;
    for (const l of lines.slice(start)) {
      const m = summaryRe.exec(l.trim());
      if (!m) continue;
      found = true;
      const key = ({ 'did not run': 'didNotRun' } as Record<string, string>)[m[2]!] ?? m[2]!;
      (counts as unknown as Record<string, number>)[key] = Number(m[1]);
    }
    if (found) e2e = counts;
  }
  return { unit, e2e };
}

// ---------------------------------------------------------------------------
// Build time
// ---------------------------------------------------------------------------

async function measureBuildTime(runs: number): Promise<PhaseRecord['buildTime']> {
  const app = apps.find((a) => a.name === 'e2e-contract')!;
  const out = join(repoRoot, '.tmp-phase-build');
  const once = async (): Promise<number> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = performance.now();
      const r = await buildApp(app, 'prod', out);
      const ms = performance.now() - t0;
      if (r.exitCode !== 0) throw new Error(`thane build --prod of ${app.name} failed:\n${r.stderr}`);
      if (r.crashRetries === 0) return ms; // a build that Bun repeated after a crash is not timed
    }
    throw new Error('thane build kept crashing Bun; no build time recorded');
  };
  try {
    const warmupMs = await once();
    const runsMs: number[] = [];
    for (let i = 0; i < runs; i++) runsMs.push(await once());
    const sorted = [...runsMs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianMs = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    const r = (n: number) => Math.round(n);
    return { app: app.name, mode: 'prod', warmupMs: r(warmupMs), runsMs: runsMs.map(r), medianMs: r(medianMs) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const n = (v: number) => v.toLocaleString('en-US');
const signed = (v: number) => (v === 0 ? '±0' : v > 0 ? `+${n(v)}` : `−${n(-v)}`);

export function renderPhase(rec: PhaseRecord, prev?: PhaseRecord): string {
  const vs = (now: number, before: number | undefined) =>
    prev && before !== undefined ? ` (${signed(now - before)} vs ${prev.label})` : '';
  const linesRow = (l: LineCounts, p?: LineCounts) =>
    (['runtime', 'compiler', 'contracts', 'total'] as const)
      .map((k) => `${k} ${n(l[k])}${vs(l[k], p?.[k])}`)
      .join(' · ');
  const out: string[] = [];
  out.push(`### Phase ${rec.label}`, '');
  out.push('| | |', '|---|---|');
  out.push(
    `| Commit | \`${rec.commit.short}\` ${rec.commit.subject}${rec.commit.dirty ? ' (uncommitted changes)' : ''} |`,
  );
  out.push(`| Framework lines (src/, non-test) | ${linesRow(rec.lines, prev?.lines)} |`);
  out.push(`| Unit-test lines | ${linesRow(rec.testLines, prev?.testLines)} |`);
  const u = rec.tests.unit;
  out.push(
    `| Unit tests | ${
      u
        ? `${n(u.pass)} pass${vs(u.pass, prev?.tests.unit?.pass)}, ${u.fail} fail${u.todo ? `, ${u.todo} todo` : ''}${u.skip ? `, ${u.skip} skip` : ''}${u.files !== null ? ` (${u.files} files)` : ''}`
        : 'not in the log'
    } |`,
  );
  const e = rec.tests.e2e;
  out.push(
    `| E2E | ${
      e
        ? [
            `${n(e.passed)} passed${vs(e.passed, prev?.tests.e2e?.passed)}`,
            e.failed ? `${e.failed} failed` : '',
            e.flaky ? `${e.flaky} flaky` : '',
            e.skipped ? `${e.skipped} skipped` : '',
            e.didNotRun ? `${e.didNotRun} did not run` : '',
            e.interrupted ? `${e.interrupted} interrupted` : '',
          ]
            .filter(Boolean)
            .join(', ') + (e.total !== null ? ` (of ${e.total})` : '')
        : 'not in the log'
    } |`,
  );
  const b = rec.buildTime;
  out.push(
    `| Build time, contract app \`--prod\` | median ${n(b.medianMs)} ms${vs(b.medianMs, prev?.buildTime.medianMs)} (runs ${b.runsMs.map(n).join(' / ')}; warm-up ${n(b.warmupMs)}) |`,
  );
  out.push(`| Log | ${rec.tests.log ?? '—'} |`);
  out.push('');

  const titles: Record<string, string> = { dist: 'dist/runtime', bundles: 'bundle', apps: 'app (prod)' };
  const withPrev = prev && prev.size.bun === rec.size.bun;
  out.push(
    `Size (gzip by Bun ${rec.size.bun}${prev && !withPrev ? `; ${prev.label} was measured with Bun ${prev.size.bun}, so no deltas` : ''}):`,
    '',
  );
  out.push(withPrev ? '| Row | raw | gzip | Δ raw | Δ gzip |' : '| Row | raw | gzip |');
  out.push(withPrev ? '|---|---:|---:|---:|---:|' : '|---|---:|---:|');
  for (const row of rec.size.rows) {
    let line = `| ${titles[row.section]} · ${row.name} | ${n(row.raw)} | ${n(row.gzip)} |`;
    if (withPrev) {
      const before = prev.size.rows.find((r) => r.section === row.section && r.name === row.name);
      line += before ? ` ${signed(row.raw - before.raw)} | ${signed(row.gzip - before.gzip)} |` : ' new | new |';
    }
    out.push(line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let label: string | undefined;
  let verifyLog: string | undefined;
  let sizeJson: string | undefined;
  let previous: string | undefined;
  let outPath: string | undefined;
  let runs = 5;
  let build = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value\n${USAGE}`);
      return v;
    };
    if (arg === '--verify-log') verifyLog = value();
    else if (arg === '--size-json') sizeJson = value();
    else if (arg === '--previous') previous = value();
    else if (arg === '--out') outPath = value();
    else if (arg === '--runs') runs = Number(value());
    else if (arg === '--no-build') build = false;
    else if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}\n${USAGE}`);
    else if (label === undefined) label = arg;
    else throw new Error(`Unexpected argument ${arg}\n${USAGE}`);
  }
  if (!label || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) throw new Error(USAGE);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be >= 1');

  if (build) buildFramework();
  const tests = verifyLog
    ? { log: resolve(verifyLog), ...parseVerifyLog(readFileSync(resolve(verifyLog), 'utf8')) }
    : { log: null, unit: null, e2e: null };
  if (verifyLog && !tests.unit) console.warn('⚠ no bun test summary found in the verify log');
  if (verifyLog && !tests.e2e) console.warn('⚠ no Playwright summary found in the verify log');
  const size = sizeJson
    ? (JSON.parse(readFileSync(resolve(sizeJson), 'utf8')) as SizeReport)
    : await measureSizes(false);
  const buildTime = await measureBuildTime(runs);

  const record: PhaseRecord = {
    label,
    generatedAt: new Date().toISOString(),
    bun: Bun.version,
    commit: {
      hash: git(['rev-parse', 'HEAD']),
      short: git(['rev-parse', '--short', 'HEAD']),
      subject: git(['log', '-1', '--format=%s']),
      dirty: git(['status', '--porcelain']).length > 0,
    },
    ...countLines(),
    tests,
    size,
    buildTime,
  };

  const file = resolve(outPath ?? join(repoRoot, 'bench/results', `phase-${label}.json`));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  const prev =
    previous && existsSync(resolve(previous))
      ? (JSON.parse(readFileSync(resolve(previous), 'utf8')) as PhaseRecord)
      : undefined;
  if (previous && !prev) console.warn(`⚠ --previous ${previous} not found; no deltas`);
  console.log(renderPhase(record, prev));
  console.log(`\nrecord written to ${file}`);
}
