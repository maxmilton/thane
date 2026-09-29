/**
 * The TypeScript plugin, as an editor uses it: a language service over one file with template event
 * handlers, wrapped by the plugin, asked for errors, hovers and completions.
 */
import { describe, expect, test } from 'bun:test';
import * as ts from 'typescript';
import init from './index.js';

const FILE = '/project/src/app.ts';
const SOURCE = [
  'declare const html: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;',
  'declare const count: (value?: number) => number;',
  'export const good = html`<b @click=${(e) => count(e.clientX)}>x</b>`;',
  'export const wrong = html`<b @click=${(e: KeyboardEvent) => e.key}>x</b>`;',
  'export const input = html`<input @input=${(e) => e.currentTarget.value} />`;',
  'const outside = 1;',
  '',
].join('\n');

/** A language service over FILE and the default libraries, wrapped by the plugin */
const service = (): ts.LanguageService => {
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    noEmit: true,
  };
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [FILE],
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => {
      if (fileName === FILE) return ts.ScriptSnapshot.fromString(SOURCE);
      const text = ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => '/project',
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (fileName) => fileName === FILE || ts.sys.fileExists(fileName),
    readFile: (fileName) => (fileName === FILE ? SOURCE : ts.sys.readFile(fileName)),
  };
  const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
  const info = {
    languageService,
    languageServiceHost: host,
    project: { getCurrentDirectory: () => '/project' },
    config: {},
  } as unknown as ts.server.PluginCreateInfo;
  return init({ typescript: ts }).create(info);
};

const at = (needle: string, offset = 0): number => SOURCE.indexOf(needle) + offset;
const flat = (parts: ts.SymbolDisplayPart[] | undefined): string => (parts ?? []).map((p) => p.text).join('');

describe('the TypeScript plugin', () => {
  const plugin = service();

  test('the semantic errors include a handler for another event, at the handler as written', () => {
    const errors = plugin.getSemanticDiagnostics(FILE);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.start).toBe(at('(e: KeyboardEvent)'));
    expect(errors[0]!.file!.text).toBe(SOURCE);
    expect(ts.flattenDiagnosticMessageText(errors[0]!.messageText, '\n')).toContain(
      'does not satisfy the expected type',
    );
  });

  test("a hover on a handler's parameter shows the event type", () => {
    const quickInfo = plugin.getQuickInfoAtPosition(FILE, at('(e) => count', 1))!;
    expect(flat(quickInfo.displayParts)).toContain('PointerEvent');
    expect(quickInfo.textSpan).toEqual({ start: at('(e) => count', 1), length: 1 });
  });

  test("completions inside a handler list the event's members, and currentTarget's for the element", () => {
    const members = plugin.getCompletionsAtPosition(FILE, at('e.clientX', 2), {})!;
    expect(members.entries.map((entry) => entry.name)).toContain('clientX');
    const target = plugin.getCompletionsAtPosition(FILE, at('e.currentTarget.value', 'e.currentTarget.'.length), {})!;
    expect(target.entries.map((entry) => entry.name)).toContain('value');
    const details = plugin.getCompletionEntryDetails(
      FILE,
      at('e.clientX', 2),
      'clientX',
      {},
      undefined,
      undefined,
      undefined,
    )!;
    expect(flat(details.displayParts)).toContain('clientX');
  });

  test("outside a handler the editor's own service answers", () => {
    const quickInfo = plugin.getQuickInfoAtPosition(FILE, at('outside'))!;
    expect(flat(quickInfo.displayParts)).toContain('const outside: 1');
    expect(plugin.getSyntacticDiagnostics(FILE)).toEqual([]);
  });
});

test('the built plugin is a CommonJS module whose export is the init function, as tsserver loads it', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const bundled = require('../../dist/ts-plugin/index.cjs');
  expect(typeof bundled).toBe('function');
  expect(typeof bundled({ typescript: ts }).create).toBe('function');
});
