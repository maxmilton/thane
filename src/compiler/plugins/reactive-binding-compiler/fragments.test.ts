/**
 * Fragments: html`` consts of the component or the module, inlined wherever a template goes. A fragment
 * named as a whenElse() branch or a repeat() empty template is its markup (it was its name, as text), a
 * fragment can be used twice, and a child component in a fragment used twice is mounted twice.
 */
import { describe, expect, test } from 'bun:test';
import { buildAndReadJs } from '../../testing/build-project.js';

const DEV = { strictTypeCheck: false };

const KID =
  "import { defineComponent } from 'thane';\n" +
  "export const FragKid = defineComponent<{ n: number }>('frag-kid', ({ props }) => ({ template: html`<em>${props.n}</em>` }));\n";

/** A component whose setup declares `declarations` and returns `template`, built in development mode */
const build = (declarations: string, template: string): Promise<string> =>
  buildAndReadJs(
    [
      "import { defineComponent, signal, mount, html, whenElse, repeat } from 'thane';",
      "import { FragKid } from './kid.js';",
      'const spinner = html`<span class="spin"></span>`;',
      "export const App = defineComponent('frag-app', () => {",
      '  const loading = signal(true);',
      '  const rows = signal([1, 2]);',
      `  ${declarations}`,
      `  return { template: html\`${template}\` };`,
      '});',
      'mount({ component: App });',
    ].join('\n'),
    { extraFiles: { 'src/kid.ts': KID }, config: DEV },
  ).then((js) => js.slice(js.indexOf('src/main.ts')));

const componentTemplate = (js: string): string => js.match(/__tpl\d* = __T\(`([^`]*)`\)/)?.[1] ?? '';

describe('fragments are inlined wherever a template goes', () => {
  test('a whenElse() branch named by a fragment is its markup', async () => {
    const js = await build(
      'const done = html`<p class="done">${loading()}</p>`;',
      '<div>${whenElse(loading(), spinner, done)}</div>',
    );
    expect(js).toContain('__bindIfExpr(_ws_b0, _wm_b0, [loading], () => loading(), `<span class="spin"></span>`');
    expect(js).toContain('`<p class="done"><!---->true<!----></p>`');
    expect(js).not.toMatch(/`spinner`|`done`/);
  });

  test('a repeat() empty template named by a fragment is its markup', async () => {
    const js = await build(
      'const empty = html`<li class="none">none</li>`;',
      '<ul>${repeat(rows(), (r) => html`<li>${r} ${spinner}</li>`, empty)}</ul>',
    );
    expect(js).toContain('__T(`<li class="none">none</li>`)');
    // The module's fragment, inside a row
    expect(js).toContain('<li><!----> <!----> <span class="spin"></span></li>');
  });

  test('a fragment used twice is inlined twice', async () => {
    const js = await build('', '<div>${spinner}${spinner}</div>');
    expect(componentTemplate(js)).toBe('<div><span class="spin"></span><span class="spin"></span></div>');
  });

  test('a child component in a fragment used twice is mounted in each place', async () => {
    const js = await build('const kid = html`<i>${FragKid({ n: 1 })}</i>`;', '<div>${kid}<b>x</b>${kid}</div>');
    expect(componentTemplate(js)).toBe('<div><i><frag-kid></frag-kid></i><b>x</b><i><frag-kid></frag-kid></i></div>');
    expect(js.match(/FragKid\.__f\(/g)).toHaveLength(2);
  });

  test('a fragment whose every use is inlined is left empty; one also used as a value keeps its markup', async () => {
    const js = await build('const kept = html`<u>k</u>`;\n  console.log(kept);', '<div>${spinner}${kept}</div>');
    // Emptied, the module's fragment is dropped by esbuild
    expect(js).not.toContain('spinner');
    expect(js).toContain('const kept = `<u>k</u>`;');
    expect(js).toContain('<div><span class="spin"></span><u>k</u></div>');
  });

  test('an html template written as a whole ${} is inlined, and its fragments with it', async () => {
    const js = await build('', '<div>${html`<p>${spinner}${loading()}</p>`}</div>');
    expect(componentTemplate(js)).toBe('<div><p><span class="spin"></span><!---->true<!----></p></div>');
  });
});
