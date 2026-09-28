/**
 * `href(pattern, params)` and `navigate(pattern, params)` are typed from the app's routes: a pattern
 * with parameters, and a value for each of its parameters. The global `navigate` (index.ts) and the one
 * `thane/router` exports take the same arguments.
 *
 * One program holds the runtime, the route types a build generates for four routes, and a usage file
 * with one case per function; a case's diagnostics are the ones on its lines.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';

const VALID: Record<string, string> = {
  'a pattern and its parameter': "navigate('/users/:id', { id: 7 });",
  'two parameters, a string and a number': "navigate('/users/:id/posts/:post', { id: 'a', post: 2 });",
  'a static path, as before': "navigate('/about');",
  "href's result is a path": "const path: RoutePaths = href('/users/:id', { id: 1 });\n  navigate(path);",
  "thane/router's navigate": "routerNavigate('/users/:id/posts/:post', { id: 1, post: 'x' });",
};
const INVALID: Record<string, [string, RegExp]> = {
  'a missing parameter': ["navigate('/users/:id', {});", /Property 'id' is missing/],
  'a parameter the pattern does not have': ["navigate('/users/:id', { id: 1, uid: 1 });", /'uid' does not exist/],
  'a parameter of the wrong type': ["href('/users/:id', { id: true });", /not assignable to type 'string \| number'/],
  'a pattern without parameters': ["href('/about', {});", /not assignable to parameter of type/],
  'a pattern that is not a route': ["href('/missing/:x', { x: 1 });", /not assignable to parameter of type/],
  "thane/router's navigate, a missing parameter": [
    "routerNavigate('/users/:id/posts/:post', { id: 1 });",
    /'post' is missing/,
  ],
};

const dir = import.meta.dir.replaceAll('\\', '/');
const REGISTER = '/typed-routes/routes.generated.d.ts';
const USAGE = '/typed-routes/usage.ts';
const register = [
  'declare global {',
  '  namespace ThaneTypeRegistry {',
  "    interface Register { routePaths: '/' | '/about' | '/users/:id' | '/users/:id/posts/:post'; }",
  '  }',
  '}',
  'export {};',
].join('\n');
const cases = Object.entries({ ...VALID, ...Object.fromEntries(Object.entries(INVALID).map(([k, [c]]) => [k, c])) });
const usage = [
  `import type { RoutePaths } from '${dir}/index.js';`,
  `import { href, navigate as routerNavigate } from '${dir}/router-exports.js';`,
  ...cases.map(([, code], i) => `export function case${i}() {\n  ${code}\n}`),
].join('\n');

/** The diagnostics of the usage file, by case name. */
const diagnosticsByCase = (): Map<string, string[]> => {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    skipLibCheck: true,
  };
  const virtual = new Map([
    [REGISTER, register],
    [USAGE, usage],
  ]);
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  const fileExists = host.fileExists;
  host.getSourceFile = (name, languageVersion, ...rest) =>
    virtual.has(name)
      ? ts.createSourceFile(name, virtual.get(name)!, languageVersion, true)
      : getSourceFile.call(host, name, languageVersion, ...rest);
  host.fileExists = (name) => virtual.has(name) || fileExists.call(host, name);
  const program = ts.createProgram([join(import.meta.dir, 'index.ts'), REGISTER, USAGE], options, host);
  const file = program.getSourceFile(USAGE)!;
  const lines = usage.split('\n');
  const byCase = new Map<string, string[]>(cases.map(([name]) => [name, []]));
  for (const d of ts.getPreEmitDiagnostics(program, file)) {
    const line = file.getLineAndCharacterOfPosition(d.start ?? 0).line;
    const fn = lines.slice(0, line + 1).findLastIndex((l) => l.startsWith('export function case'));
    const name = fn === -1 ? 'setup' : cases[Number(/case(\d+)/.exec(lines[fn]!)![1])]![0];
    byCase.set(name, [...(byCase.get(name) ?? []), ts.flattenDiagnosticMessageText(d.messageText, '\n')]);
  }
  return byCase;
};

let computed: Map<string, string[]> | undefined;
const diagnostics = (): Map<string, string[]> => (computed ??= diagnosticsByCase());

describe('typed route parameters', () => {
  test('a pattern with a value for each parameter type-checks, with either navigate', () => {
    expect(diagnostics().get('setup')).toBeUndefined();
    for (const name of Object.keys(VALID)) expect({ [name]: diagnostics().get(name) }).toEqual({ [name]: [] });
  }, 60_000);

  for (const [name, [, message]] of Object.entries(INVALID)) {
    test(`${name} is a type error`, () => {
      expect(diagnostics().get(name)?.join('\n')).toMatch(message);
    });
  }
});
