/**
 * Compares two snapshot sets written by `bun run snapshot:output`.
 *
 *   bun run snapshot:compare <dir-a> <dir-b>
 *
 * Prints `identical (<n> files)` and exits 0 when every file matches. Otherwise lists the files that
 * differ or exist on one side only, prints a unified diff of the first differing file, and exits 1.
 * Minified bundles are one long line, so long lines in the diff are cut to a window around the
 * first changed column. For the full diff of one file use `git diff --no-index <a>/<file> <b>/<file>`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CONTEXT = 3;
const MAX_DIFF_LINES = 150;
const MAX_EDIT_DISTANCE = 4000;
const LINE_WINDOW = 240;

type Op = { kind: ' ' | '-' | '+'; text: string; a: number; b: number };

/** Myers diff of two line arrays after trimming the common prefix and suffix. */
export function diffLines(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);

  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: ' ', text: a[i]!, a: i, b: i });
  ops.push(...myers(A, B).map((op) => ({ ...op, a: op.a + pre, b: op.b + pre })));
  for (let i = 0; i < suf; i++) {
    const ai = a.length - suf + i;
    ops.push({ kind: ' ', text: a[ai]!, a: ai, b: b.length - suf + i });
  }
  return ops;
}

function myers(A: string[], B: string[]): Op[] {
  const N = A.length;
  const M = B.length;
  const max = Math.min(N + M, MAX_EDIT_DISTANCE);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = N === 0 && M === 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // v before step d, for k in [-d-1, d+1]
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        found = true;
        break;
      }
    }
  }
  if (!found) {
    // Too different for a readable diff: everything removed, then everything added.
    return [
      ...A.map((text, i): Op => ({ kind: '-', text, a: i, b: 0 })),
      ...B.map((text, i): Op => ({ kind: '+', text, a: N, b: i })),
    ];
  }
  const ops: Op[] = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d]!;
    const at = (k: number) => t[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: ' ', text: A[x]!, a: x, b: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        ops.push({ kind: '+', text: B[y]!, a: x, b: y });
      } else {
        x--;
        ops.push({ kind: '-', text: A[x]!, a: x, b: y });
      }
    }
  }
  return ops.reverse();
}

const commonPrefix = (s: string, t: string) => {
  let i = 0;
  while (i < s.length && i < t.length && s[i] === t[i]) i++;
  return i;
};

const clip = (line: string, col: number) => {
  if (line.length <= LINE_WINDOW) return line;
  const start = Math.max(0, Math.min(col - 80, line.length - LINE_WINDOW));
  const end = start + LINE_WINDOW;
  return `${start > 0 ? `…[${start} chars]` : ''}${line.slice(start, end)}${end < line.length ? `…[+${line.length - end}]` : ''}`;
};

/** Unified diff (3 lines of context) of two texts. */
export function unifiedDiff(nameA: string, nameB: string, textA: string, textB: string): string[] {
  const ops = diffLines(textA.split('\n'), textB.split('\n'));
  const changed = ops.flatMap((op, i) => (op.kind === ' ' ? [] : [i]));
  const out = [`--- ${nameA}`, `+++ ${nameB}`];
  let h = 0;
  while (h < changed.length) {
    const start = Math.max(0, changed[h]! - CONTEXT);
    let end = changed[h]!;
    while (h < changed.length && changed[h]! - end <= 2 * CONTEXT) end = changed[h++]!;
    end = Math.min(ops.length - 1, end + CONTEXT);
    const hunk = ops.slice(start, end + 1);
    const aLen = hunk.filter((op) => op.kind !== '+').length;
    const bLen = hunk.filter((op) => op.kind !== '-').length;
    const firstA = hunk.find((op) => op.kind !== '+');
    const firstB = hunk.find((op) => op.kind !== '-');
    const aStart = aLen ? firstA!.a + 1 : hunk[0]!.a;
    const bStart = bLen ? firstB!.b + 1 : hunk[0]!.b;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    // Column of the first change, for cutting long lines to a readable window
    const removed = hunk.find((op) => op.kind === '-');
    const added = hunk.find((op) => op.kind === '+');
    const col = removed && added ? commonPrefix(removed.text, added.text) : 0;
    for (const op of hunk) out.push(op.kind + clip(op.text, op.kind === ' ' ? 0 : col));
  }
  return out;
}

const listSnapshots = (dir: string): string[] => {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .sort();
};

if (import.meta.main) {
  const [argA, argB, ...rest] = process.argv.slice(2);
  if (!argA || !argB || rest.length > 0) {
    console.error('Usage: bun run snapshot:compare <dir-a> <dir-b>');
    process.exit(2);
  }
  const dirA = resolve(argA);
  const dirB = resolve(argB);
  const filesA = listSnapshots(dirA);
  const filesB = listSnapshots(dirB);
  if (filesA.length === 0 || filesB.length === 0) {
    console.error(`No snapshot files in ${filesA.length === 0 ? dirA : dirB}`);
    process.exit(2);
  }
  const setB = new Set(filesB);
  const setA = new Set(filesA);
  const onlyA = filesA.filter((f) => !setB.has(f));
  const onlyB = filesB.filter((f) => !setA.has(f));
  const changed = filesA.filter((f) => setB.has(f) && !readFileSync(join(dirA, f)).equals(readFileSync(join(dirB, f))));

  if (onlyA.length + onlyB.length + changed.length === 0) {
    console.log(`identical (${filesA.length} files)`);
    process.exit(0);
  }

  const total = new Set([...filesA, ...filesB]).size;
  console.log(`${changed.length + onlyA.length + onlyB.length} of ${total} files differ`);
  console.log(`  a: ${dirA}\n  b: ${dirB}\n`);
  for (const f of changed) console.log(`  changed    ${f}`);
  for (const f of onlyA) console.log(`  only in a  ${f}`);
  for (const f of onlyB) console.log(`  only in b  ${f}`);

  const first = changed[0];
  if (first) {
    const lines = unifiedDiff(
      `a/${first}`,
      `b/${first}`,
      readFileSync(join(dirA, first), 'utf8'),
      readFileSync(join(dirB, first), 'utf8'),
    );
    console.log('');
    for (const line of lines.slice(0, MAX_DIFF_LINES)) console.log(line);
    if (lines.length > MAX_DIFF_LINES) console.log(`… ${lines.length - MAX_DIFF_LINES} more diff lines`);
  }
  process.exit(1);
}
