/**
 * Characterisation of the console colour strings (before CL-3), with colour forced on and off.
 * `supportsColor` is decided when the module loads, so each mode runs in a child process.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const COLORS = join(import.meta.dir, 'colors.ts').replace(/\\/g, '/');

const load = (forceColor: string) => {
  const script = `const m = await import(${JSON.stringify(COLORS)}); console.log(JSON.stringify({ supportsColor: m.supportsColor, consoleColors: m.consoleColors, ansi: m.ansi }));`;
  const run = Bun.spawnSync([process.execPath, '-e', script], {
    env: { ...process.env, FORCE_COLOR: forceColor },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
};

const E = '\x1b[';

describe('console colours', () => {
  test('colour on', () => {
    expect(load('1')).toEqual({
      supportsColor: true,
      consoleColors: {
        green: `${E}32m%s${E}0m`,
        yellow: `${E}33m%s${E}0m`,
        blue: `${E}94m%s${E}0m`,
        cyan: `${E}36m%s${E}0m`,
        red: `${E}31m%s${E}0m`,
        orange: `${E}38;5;208m%s${E}0m`,
      },
      ansi: {
        green: `${E}32m`,
        yellow: `${E}33m`,
        blue: `${E}94m`,
        cyan: `${E}36m`,
        red: `${E}31m`,
        magenta: `${E}35m`,
        orange: `${E}38;5;208m`,
        gray: `${E}90m`,
        dim: `${E}2m`,
        reset: `${E}0m`,
      },
    });
  });

  test('colour off', () => {
    expect(load('0')).toEqual({
      supportsColor: false,
      // no `reset` since H-25: interpolated into a line, its '%s' was printed literally
      consoleColors: { green: '%s', yellow: '%s', blue: '%s', cyan: '%s', red: '%s', orange: '%s' },
      ansi: {
        green: '',
        yellow: '',
        blue: '',
        cyan: '',
        red: '',
        magenta: '',
        orange: '',
        gray: '',
        dim: '',
        reset: '',
      },
    });
  });

  test('key order', () => {
    const on = load('1');
    expect(Object.keys(on.consoleColors)).toEqual(['green', 'yellow', 'blue', 'cyan', 'red', 'orange']);
    expect(Object.keys(on.ansi)).toEqual([
      'green',
      'yellow',
      'blue',
      'cyan',
      'red',
      'magenta',
      'orange',
      'gray',
      'dim',
      'reset',
    ]);
  });
});
