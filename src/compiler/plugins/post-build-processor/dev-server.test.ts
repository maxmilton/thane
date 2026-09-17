import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveRequestPath } from './dev-server.js';

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
