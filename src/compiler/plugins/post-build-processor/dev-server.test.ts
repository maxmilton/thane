import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { DevServer, resolveRequestPath } from './dev-server.js';

describe('Dev server request paths', () => {
  const dist = join(process.cwd(), 'some', 'dist');

  test('percent-encoded characters are decoded, so file names with spaces resolve', () => {
    expect(resolveRequestPath(dist, '/assets/My%20Logo%20-%20Big.png')).toBe(join(dist, 'assets', 'My Logo - Big.png'));
  });

  test('a path that escapes the output directory is refused, encoded or not', () => {
    expect(resolveRequestPath(dist, '/../secret.txt')).toBeNull();
    expect(resolveRequestPath(dist, '/..%2F..%2Fsecret.txt')).toBeNull();
  });

  test('a malformed escape sequence is refused instead of throwing', () => {
    expect(resolveRequestPath(dist, '/assets/%E0%A4%A')).toBeNull();
  });
});

describe('H-23: the browser-error relay names locations the way requests are resolved', () => {
  const dist = join(process.cwd(), 'some', 'dist');

  /** The lines the relay prints for one page error. */
  const relay = (source: string, stack?: string): string[] => {
    const server = new DevServer({ distDir: dist });
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      (server as unknown as { logBrowserRelayMessage(message: object): void }).logBrowserRelayMessage({
        level: 'pageerror',
        pageUrl: 'http://localhost:4200/',
        message: 'boom',
        source,
        lineno: 3,
        colno: 4,
        stack,
      });
    } finally {
      console.error = error;
    }
    return lines;
  };

  test('a file in the output directory, relative to it and decoded', () => {
    expect(relay('http://localhost:4200/assets/My%20File.js')).toEqual([
      '[THANE_BROWSER_ERROR] Uncaught boom',
      'source assets/My File.js:3:4',
      '',
    ]);
  });

  test('stack locations are shortened the same way', () => {
    expect(
      relay('http://localhost:4200/main.js', 'Error: x\n    at f (http://localhost:4200/chunk%201.js:5:6)'),
    ).toEqual(['[THANE_BROWSER_ERROR] Uncaught boom', 'source main.js:3:4', 'stack at chunk 1.js:5:6', '']);
  });

  test('a script from another origin keeps its file name', () => {
    expect(relay('file:///C:/x/lib.js')).toEqual(['[THANE_BROWSER_ERROR] Uncaught boom', 'source lib.js:3:4', '']);
  });
});
