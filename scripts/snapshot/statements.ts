/**
 * Runtime-task equivalence helper (RT-app, wave 1).
 *
 *   bun run snapshot:statements <base dir> <new dir> [--marker <regex>] [--show <n>]
 *
 * The snapshot sets bundle the runtime, so a runtime change shows up in every bundle that contains
 * the changed code. This script:
 *  - lists the changed files;
 *  - with --marker: checks that the changed files are exactly the base files matching the regex
 *    (the bundles that contain the changed runtime code), and reports both kinds of mismatch;
 *  - prints, for each changed file, the differing statements after splitting on ; { } and
 *    replacing identifiers of up to 3 characters (minified names) with `_`, so that esbuild's
 *    renaming does not hide where the real change is. Limited to --show statements per file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const a = argv[0]!;
const b = argv[1]!;
let marker: RegExp | undefined;
let show = 12;
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--marker') marker = new RegExp(argv[++i]!);
  else if (argv[i] === '--show') show = Number(argv[++i]);
}

const filesA = readdirSync(a).sort();
const filesB = new Set(readdirSync(b));
const changed: string[] = [];
const onlyA: string[] = [];
for (const f of filesA) {
  if (!filesB.has(f)) {
    onlyA.push(f);
    continue;
  }
  if (readFileSync(join(a, f), 'utf8') !== readFileSync(join(b, f), 'utf8')) changed.push(f);
}
const onlyB = [...filesB].filter((f) => !filesA.includes(f));
console.log(
  `${changed.length} of ${filesA.length} files changed; only in base: ${onlyA.length}; only in new: ${onlyB.length}`,
);

if (marker) {
  const withMarker = filesA.filter((f) => marker!.test(readFileSync(join(a, f), 'utf8')));
  const changedSet = new Set(changed);
  const markerSet = new Set(withMarker);
  const changedNoMarker = changed.filter((f) => !markerSet.has(f));
  const markerUnchanged = withMarker.filter((f) => !changedSet.has(f));
  console.log(`marker ${marker}: ${withMarker.length} base files match`);
  console.log(`  changed-without-marker: ${changedNoMarker.length ? changedNoMarker.join(', ') : 'none'}`);
  console.log(`  marker-but-unchanged: ${markerUnchanged.length ? markerUnchanged.join(', ') : 'none'}`);
}

// Short identifiers (minified names) become `_`, except property names after a single dot
// (`a.el` keeps `el`; a spread `...w` is renamed). Output files (`/* name */` sections) are
// sorted by their normalised text, so that chunks whose hashed names changed order still match.
const normText = (s: string): string =>
  s.replace(/(?<![A-Za-z0-9_$#])(?<![^.]\.)[A-Za-z_$][A-Za-z0-9_$]{0,2}(?![A-Za-z0-9_$])/g, '_');
const norm = (s: string): string[] =>
  s
    .split(/(?=^\/\* [^*\n]+ \*\/$)/m)
    .map(normText)
    .sort()
    .join('\n')
    .split(/(?<=[;{}])/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Statements only in x / only in y, by LCS. */
const diff = (x: string[], y: string[]): { del: string[]; add: string[] } => {
  // trim common prefix and suffix first
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let sx = x.length,
    sy = y.length;
  while (sx > p && sy > p && x[sx - 1] === y[sy - 1]) {
    sx--;
    sy--;
  }
  const xs = x.slice(p, sx);
  const ys = y.slice(p, sy);
  const n = xs.length,
    m = ys.length;
  if (n * m > 4e7) return { del: xs, add: ys };
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = xs[i] === ys[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const del: string[] = [];
  const add: string[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (xs[i] === ys[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) del.push(xs[i++]!);
    else add.push(ys[j++]!);
  }
  while (i < n) del.push(xs[i++]!);
  while (j < m) add.push(ys[j++]!);
  return { del, add };
};

const summary = new Map<string, string[]>();
for (const f of changed) {
  const { del, add } = diff(norm(readFileSync(join(a, f), 'utf8')), norm(readFileSync(join(b, f), 'utf8')));
  const key = JSON.stringify([del, add]);
  if (!summary.has(key)) summary.set(key, []);
  summary.get(key)!.push(f);
}
let group = 0;
for (const [key, files] of summary) {
  const [del, add] = JSON.parse(key) as [string[], string[]];
  group++;
  console.log(
    `\n=== diff group ${group}: ${files.length} file(s): ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''}`,
  );
  console.log(`  - ${del.length} statement(s) removed, + ${add.length} added`);
  for (const s of del.slice(0, show)) console.log(`  - ${s.length > 220 ? s.slice(0, 220) + '…' : s}`);
  if (del.length > show) console.log(`  - … ${del.length - show} more`);
  for (const s of add.slice(0, show)) console.log(`  + ${s.length > 220 ? s.slice(0, 220) + '…' : s}`);
  if (add.length > show) console.log(`  + … ${add.length - show} more`);
}
