/**
 * The global `repeat()` declaration (index.ts, `declare global`) type-checks every empty
 * template the compiler takes, and rejects a function in the third argument, where a key function is
 * easily written by mistake: `repeat(items, row, (it) => it.id)` (the key function goes fourth).
 *
 * One program holds the runtime's declarations and a usage file with one call per case, each in its
 * own function; a case's diagnostics are the ones on its lines.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';

const VALID: Record<string, string> = {
  'no empty template': 'repeat(items, row)',
  'null, then a key function': 'repeat(items, row, null, (it) => it.id)',
  'undefined, then a key function': 'repeat(items, row, undefined, (it) => it.id)',
  'an html template': 'repeat(items, row, html`<li>none</li>`)',
  'an html template and a key function': 'repeat(items, row, html`<li>none</li>`, (it) => it.id)',
  'a plain template literal': 'repeat(items, row, `<li>none</li>`)',
  'a signal read as the items': 'repeat(() => items, row, null, (it, i) => `${it.id}-${i}`)',
};
const INVALID: Record<string, string> = {
  'an arrow function': 'repeat(items, row, (it) => it.id)',
  'a function expression': 'repeat(items, row, function (it: { id: number }) { return it.id; })',
};

const USAGE = '/h54/usage.ts';
const cases = Object.entries({ ...VALID, ...INVALID });
const usage = [
  'export {};',
  'const items = [{ id: 1 }];',
  'const row = (it: { id: number }) => html`<li>${it.id}</li>`;',
  ...cases.map(([, call], i) => `export function case${i}() {\n  return ${call};\n}`),
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
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  const fileExists = host.fileExists;
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === USAGE
      ? ts.createSourceFile(name, usage, languageVersion, true)
      : getSourceFile.call(host, name, languageVersion, ...rest);
  host.fileExists = (name) => name === USAGE || fileExists.call(host, name);
  const program = ts.createProgram([join(import.meta.dir, 'index.ts'), USAGE], options, host);
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

describe('the global repeat() declaration', () => {
  test('every empty template the compiler takes type-checks', () => {
    expect(diagnostics().get('setup')).toBeUndefined();
    for (const name of Object.keys(VALID)) expect({ [name]: diagnostics().get(name) }).toEqual({ [name]: [] });
  }, 60_000);

  for (const name of Object.keys(INVALID)) {
    test(`${name} in the third argument is a type error`, () => {
      expect(diagnostics().get(name)?.join('\n')).toMatch(/not assignable/);
    }, 60_000);
  }
});
