/**
 * Characterisation of the size report printed after a build (before PB-3).
 *
 * A real build runs with console.info captured. Every line of the report is checked against the
 * sizes of the files on disk: per-file raw size, colour band, gzip and brotli sizes, and the
 * totals. The expected text is today's format, including its hard-coded colour codes (H-25
 * changes those later).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runBuild } from '../../cli/build.js';
import { createTempProject, createTestBuildConfig, removeTempProject } from '../../testing/build-project.js';
import { consoleColors } from '../../utils/index.js';

const APP = `
import { defineComponent, mount } from 'thane';

export const App = defineComponent('test-app', () => ({
  template: html\`<div>size report</div>\`,
}));
mount({ component: App });
`;

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';

const sizeColor = (size: number, max: number): string => {
  const ratio = size / max;
  if (ratio < 0.33) return GREEN;
  if (ratio < 0.66) return '\x1b[33m';
  if (ratio < 0.85) return '\x1b[38;5;208m';
  return '\x1b[31m';
};

const kb = (bytes: number): string => (bytes / 1024).toFixed(2);

/** Build with console.info captured; returns every call's arguments and the output folder's files. */
const buildAndCapture = async (useGzip: boolean) => {
  const project = await createTempProject(APP);
  const calls: unknown[][] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => calls.push(args);
  try {
    await runBuild(createTestBuildConfig(project, { useGzip, strictTypeCheck: false }));
  } finally {
    console.info = info;
  }
  const size = (name: string): number | undefined => {
    const file = join(project.outDir, name);
    return existsSync(file) ? statSync(file).size : undefined;
  };
  const files = readdirSync(project.outDir);
  return { project, calls, size, files };
};

const expectReport = async (useGzip: boolean) => {
  const { project, calls, size, files } = await buildAndCapture(useGzip);
  try {
    const { reset } = consoleColors;
    const fileLines = calls.filter((args) => args.length === 1 && String(args[0]).startsWith(CYAN));
    const names = fileLines.map((args) => String(args[0]).slice(CYAN.length).split(reset)[0] ?? '');

    // One line per emitted file (the compressed copies are not listed)
    expect([...names].sort()).toEqual(files.filter((f) => !f.endsWith('.gz') && !f.endsWith('.br')).sort());
    expect(names).toContain('index.html');
    expect(names.some((n) => n.endsWith('.js.map'))).toBe(true);

    const raw = names.map((n) => size(n) ?? 0);
    const max = Math.max(...raw);
    const expectedLines = names.map((name, i) => {
      let line = `${CYAN}${name}${reset}  ${sizeColor(raw[i]!, max)}Size: ${kb(raw[i]!)} KB${reset}`;
      const gz = size(name + '.gz');
      const br = size(name + '.br');
      if (useGzip && gz !== undefined) {
        line += ` ${GREEN}(gzip: ${kb(gz)} KB` + (br !== undefined ? `, br: ${kb(br)} KB)` : ')') + reset;
      }
      return [line];
    });
    expect(fileLines).toEqual(expectedLines);

    // The totals follow the last file line
    const total = raw.reduce((a, b) => a + b, 0);
    const totals: unknown[][] = [
      [consoleColors.green, `=== TOTAL BUNDLE SIZE: ${total.toFixed(2)} B (${kb(total)} KB) ===`],
    ];
    if (useGzip) {
      const gzTotal = names.reduce((sum, n) => sum + (size(n + '.gz') ?? 0), 0);
      const brTotal = names.reduce((sum, n) => sum + (size(n + '.br') ?? 0), 0);
      // The source map is not compressed, so it has no gzip part and adds nothing to the totals
      expect(size(names.find((n) => n.endsWith('.js.map'))! + '.gz')).toBeUndefined();
      expect(gzTotal).toBeGreaterThan(0);
      totals.push(
        [consoleColors.green, `=== TOTAL GZIPPED: ${gzTotal.toFixed(2)} B (${kb(gzTotal)} KB) ===`],
        [consoleColors.green, `=== TOTAL BROTLI: ${brTotal.toFixed(2)} B (${kb(brTotal)} KB) ===`],
      );
    }
    totals.push(['']);
    const start = calls.indexOf(fileLines[fileLines.length - 1]!) + 1;
    expect(calls.slice(start, start + totals.length)).toEqual(totals);
  } finally {
    await removeTempProject(project);
  }
};

describe('Size report', () => {
  test('without compression: one line per file and the total', async () => {
    await expectReport(false);
  });

  test('with useGzip: gzip and brotli sizes per file and in total', async () => {
    await expectReport(true);
  });
});
