/**
 * repeat()'s third argument is the empty template.
 * Every form the compiler takes there builds, pinned by what it emits: none, `null` or `undefined`
 * with a key function fourth, an html template and a plain template literal. A function there is a
 * key function written third by mistake; it was taken as the empty template's markup (the list keyed
 * by index, and emptying it threw), and is a build error from H-54 on (THANE010).
 */
import { describe, expect, test } from 'bun:test';
import { buildAndReadJs } from '../../testing/build-project.js';

const DEV = { config: { strictTypeCheck: false } };
const ROW = '(it) => html`<li>${it.label}</li>`';

/** A component whose template is `<ul>${list}</ul>`, over items `{ id, label, kids }`. */
const app = (list: string): string => `
import { defineComponent, signal, mount } from 'thane';
export const H54App = defineComponent('h54-empty-template-app', () => {
  const items = signal([{ id: 1, label: 'A', kids: [{ id: 2, n: 'k' }] }]);
  return { template: html\`<ul>\${${list}}</ul>\` };
});
mount({ component: H54App, target: document.getElementById('app')! });
`;

const build = (list: string): Promise<string> => buildAndReadJs(app(list), DEV);

/** The markup of the list's empty template, or undefined when it has none. */
const emptyTemplateOf = (js: string): string | undefined => /_empty_b\d+ \?\?= __T\(`([^`]*)`\)/.exec(js)?.[1];

/** How the list keys its rows: by index, or by the property a key function reads. */
const keyOf = (js: string): string | undefined =>
  /\n\s*\(_, i\) => i,?\n/.test(js) ? 'index' : /\n\s*"(\w+)",?\n/.exec(js.slice(js.indexOf('_ct_b0,')))?.[1];

const TIMEOUT = 60_000;

describe('H-54 the empty template argument of repeat()', () => {
  for (const [what, list, empty, key] of [
    ['no empty template', `repeat(items(), ${ROW})`, undefined, 'index'],
    ['null, then a key function', `repeat(items(), ${ROW}, null, (it) => it.id)`, undefined, 'id'],
    ['undefined, then a key function', `repeat(items(), ${ROW}, undefined, (it) => it.id)`, undefined, 'id'],
    ['an html template', `repeat(items(), ${ROW}, html\`<li>none</li>\`)`, '<li>none</li>', 'index'],
    [
      'an html template and a key function',
      `repeat(items(), ${ROW}, html\`<li>none</li>\`, (it) => it.id)`,
      '<li>none</li>',
      'id',
    ],
    ['a plain template literal', `repeat(items(), ${ROW}, \`<li>none</li>\`)`, '<li>none</li>', 'index'],
  ] as const) {
    test(
      `${what} builds`,
      async () => {
        const js = await build(list);
        expect(emptyTemplateOf(js)).toBe(empty);
        expect(keyOf(js)).toBe(key);
      },
      TIMEOUT,
    );
  }

  const rejected = (list: string, key: string) =>
    expect(build(list)).rejects.toThrow(
      new RegExp(
        `THANE010: the third argument of repeat\\(\\) is the empty template[\\s\\S]*repeat\\(items, row, null, ${key.replace(/[()$.{}]/g, '\\$&')}\\)`,
      ),
    );

  test(
    'H-54 an arrow function in the third argument is a build error that shows the null, key form',
    () => rejected(`repeat(items(), ${ROW}, (it) => it.id)`, '(it) => it.id'),
    TIMEOUT,
  );
  test(
    'H-54 a function expression in the third argument is a build error',
    () => rejected(`repeat(items(), ${ROW}, function (it) { return it.id; })`, 'function (it) { return it.id; }'),
    TIMEOUT,
  );
  test(
    "H-54 a function in the third argument of a row's nested repeat() is a build error",
    () =>
      rejected(
        'repeat(items(), (it) => html`<li><ol>${repeat(it.kids, (k) => html`<li>${k.n}</li>`, (k) => k.id)}</ol></li>`)',
        '(k) => k.id',
      ),
    TIMEOUT,
  );
});

describe('THANE011 the empty template is one static element', () => {
  // It is inserted as one element while the list is empty: only a first element ever showed, text
  // alone threw when the list emptied, and a ${…} showed as written
  for (const [what, empty, markup] of [
    ['a void element', 'html`<hr>`', '<hr>'],
    ['one element with whitespace around it', 'html`  <li class="none">none</li>  `', '<li class="none">none</li>'],
  ] as const) {
    test(
      `${what} builds`,
      async () => expect(emptyTemplateOf(await build(`repeat(items(), ${ROW}, ${empty})`))).toBe(markup),
      TIMEOUT,
    );
  }

  for (const [what, empty, message] of [
    ['two elements', 'html`<li>no</li><li>items</li>`', /THANE011: repeat\(\)'s empty template must be one element/],
    ['text alone', 'html`No items`', /THANE011: repeat\(\)'s empty template must be one element/],
    ['text next to an element', 'html`No <b>items</b>`', /THANE011: repeat\(\)'s empty template must be one element/],
    ['a binding', 'html`<li>${items().length} items</li>`', /THANE011: repeat\(\)'s empty template is static/],
  ] as const) {
    test(
      `${what} is a build error`,
      () => expect(build(`repeat(items(), ${ROW}, ${empty})`)).rejects.toThrow(message),
      TIMEOUT,
    );
  }
});
