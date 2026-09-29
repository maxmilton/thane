/**
 * Hot updates for `thane dev` (hot-modules.ts, cli/hot-updates.ts): which files the page can swap, what a
 * module adds to register itself in the page, and the update of a changed component file, whose imports
 * read from the page's modules.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { createHotState, hotRegistration, isSwappable, trackHotInput } from './hot-modules.js';
import { buildHotUpdates } from '../../cli/hot-updates.js';
import { createBuildContext } from '../../utils/index.js';

const parse = (text: string): ts.SourceFile =>
  ts.createSourceFile('/p/src/x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

describe('the files the page can swap', () => {
  const cases: [string, string, boolean][] = [
    ['a component file', 'export const Card = defineComponent(() => ({ template: html`` }));', true],
    [
      'components and types',
      'const Row = defineComponent(() => ({}));\nexport const List = defineComponent(() => ({}));\n' +
        'export type Item = { id: number };\nexport interface Props { n: number }\nexport type { Other } from "./other.js";',
      true,
    ],
    [
      'a file that exports a helper too',
      'export const Card = defineComponent(() => ({}));\nexport const f = () => 1;',
      false,
    ],
    ['a file that exports a name later', 'const Card = defineComponent(() => ({}));\nexport { Card };', false],
    ['a file without a component', 'export const count = signal(0);', false],
    ['a function declaration exported', 'export const C = defineComponent(() => ({}));\nexport function f() {}', false],
  ];
  for (const [name, text, swappable] of cases) {
    test(`${name}: ${swappable ? 'swapped' : 'reloaded'}`, () => expect(isSwappable(parse(text))).toBe(swappable));
  }

  test('a file changes when it is built again with other text', () => {
    const hot = createHotState();
    trackHotInput(hot, 'a.ts', 'one', () => true);
    expect(hot.changed.size).toBe(0);
    trackHotInput(hot, 'a.ts', 'one', () => true);
    expect(hot.changed.size).toBe(0);
    trackHotInput(hot, 'a.ts', 'two', () => false);
    expect([...hot.changed]).toEqual([['a.ts', false]]);
  });
});

test('a module registers its namespace and the packages it imports at run time', () => {
  const text = [
    "import { defineComponent, html } from 'thane';",
    "import type { Route } from 'thane/router';",
    "import { clicks } from './store.js';",
    "export * from 'some-package';",
    '',
  ].join('\n');
  const code = "import { __registerComponentLean } from 'thane/runtime';\n" + text;
  expect(hotRegistration('/p/src/label.ts', code, parse(text), '/p').split('\n').slice(-6)).toEqual([
    'import * as __thane_hot_self from "./label.js";',
    'import * as __thane_hot_pkg0 from "thane";',
    'import * as __thane_hot_pkg1 from "some-package";',
    'import * as __thane_hot_pkg2 from "thane/runtime";',
    '(globalThis.__thaneModules ??= new Map()).set("src/label.ts", __thane_hot_self).set("pkg:thane", __thane_hot_pkg0).set("pkg:some-package", __thane_hot_pkg1).set("pkg:thane/runtime", __thane_hot_pkg2);',
    '',
  ]);
});

describe('the update of a changed component file', () => {
  let root = '';
  const FILES: Record<string, string> = {
    'package.json': '{ "name": "hot-fixture", "type": "module" }',
    'src/store.ts': "import { signal } from 'thane';\nexport const clicks = signal(0);\n",
    'src/label.css': 'b { color: red; }\n',
    'src/label.ts': [
      "import { defineComponent, html } from 'thane';",
      "import { clicks } from './store.js';",
      "import styles from './label.css';",
      "export const HotLabel = defineComponent('hot-label', () => ({",
      '  template: html`<b>${clicks()}</b>`,',
      '  styles,',
      '}));',
      '',
    ].join('\n'),
  };

  beforeAll(async () => {
    root = await mkdtemp(join(process.cwd(), '.tmp-thane-hot-'));
    for (const [file, text] of Object.entries(FILES)) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), text);
    }
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  const updatesFor = async (changed: [string, boolean][]) => {
    const buildContext = await createBuildContext(root);
    buildContext.hot = createHotState();
    for (const [file, swappable] of changed) buildContext.hot.changed.set(join(root, file), swappable);
    return buildHotUpdates({ buildContext, define: { __THANE_DEV__: 'true' }, target: ['es2022'] });
  };

  test('is its compiled code, which imports every other module and package from the page', async () => {
    const [update, ...rest] = (await updatesFor([['src/label.ts', true]]))!;
    expect(rest).toEqual([]);
    expect(update!.key).toBe('src/label.ts');
    expect(update!.code).toContain('require("__thane_module__:src/store.ts")');
    expect(update!.code).toContain('require("__thane_package__:thane/runtime")');
    expect(update!.code).toContain('__registerComponent)("hot-label"');
    // Its stylesheet is part of it
    expect(update!.code).toContain('b { color: red; }');
    expect(update!.code).not.toMatch(/__thaneModules|__thane_hot_self/);
  });

  test('is none when another kind of file changed: the page reloads', async () => {
    expect(
      await updatesFor([
        ['src/label.ts', true],
        ['src/store.ts', false],
      ]),
    ).toBeNull();
    expect(await updatesFor([])).toBeNull();
  });
});
