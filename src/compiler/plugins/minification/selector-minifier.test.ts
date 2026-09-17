import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { SelectorMap, planSelectorRenames, renameSelectorsInHtml } from './selector-minifier.js';
import type { SelectorPlanInput } from './selector-minifier.js';

const ROOT = path.resolve('/project');
const file = (relativePath: string, text: string): { path: string; text: string } => ({
  path: path.join(ROOT, relativePath),
  text,
});

const CARD = file(
  'src/card.ts',
  'export const MyCard = defineComponent(() => ({ template: html`<b>card</b>`, styles: css`:host { display: block; }` }));',
);

const plan = (input: Partial<SelectorPlanInput>): SelectorMap =>
  planSelectorRenames({ selectors: ['my-card'], tsFiles: [CARD], cssFiles: [], html: '', ...input });

describe('planSelectorRenames', () => {
  test('a selector that only the compiler writes is renamed', () => {
    expect(plan({}).get('my-card')).toBe('a-a');
  });

  test('host classes in css templates, imported stylesheets and index.html tags are renameable', () => {
    const page = file(
      'src/page.ts',
      "import styles from './page.css';\nexport const MyPage = defineComponent('my-page', () => ({ template: html`<div>${MyCard({})}</div>`, styles: css`.my-card { margin: 0; }` }));",
    );
    const map = plan({
      selectors: ['my-card', 'my-page'],
      tsFiles: [CARD, page],
      cssFiles: [file('src/page.css', '.my-card:hover { color: red; }')],
      html: '<body><my-page></my-page></body>',
    });
    expect(map.get('my-card')).toBe('a-a');
    expect(map.get('my-page')).toBe('a-b');
    expect(map.hasStylesheet(path.join(ROOT, 'src/page.css'))).toBe(true);
  });

  const keptBecause = (label: string, input: Partial<SelectorPlanInput>): void => {
    test(`kept when it appears ${label}`, () => {
      expect(plan(input).get('my-card')).toBeUndefined();
    });
  };

  keptBecause('in an ordinary string', {
    tsFiles: [CARD, file('src/routes.ts', "export const path = '/my-card/details';")],
  });
  keptBecause('as a class in a template', {
    tsFiles: [CARD, file('src/page.ts', 'export const t = html`<div class="my-card"></div>`;')],
  });
  keptBecause('as a hand-written tag in a template', {
    tsFiles: [CARD, file('src/page.ts', 'export const t = html`<my-card></my-card>`;')],
  });
  keptBecause('in a querySelector call', {
    tsFiles: [CARD, file('src/page.ts', "document.querySelector('my-card');")],
  });
  keptBecause('in a stylesheet no module imports', {
    cssFiles: [file('src/assets/site.css', '.my-card { color: red; }')],
  });
  keptBecause('as an element selector in an imported stylesheet', {
    tsFiles: [CARD, file('src/page.ts', "import s from './page.css';")],
    cssFiles: [file('src/page.css', 'my-card { color: red; }')],
  });
  keptBecause('inside a CSS comment or string', {
    tsFiles: [CARD, file('src/page.ts', 'export const s = css`/* my-card */ .x { content: "my-card"; }`;')],
  });
  keptBecause('inside a substitution of a css template', {
    tsFiles: [CARD, file('src/page.ts', "export const s = css`.x { color: ${pick('my-card')}; }`;")],
  });
  keptBecause('as an attribute value in index.html', {
    html: '<body><div data-mount="my-card"></div></body>',
  });
  keptBecause('in a css template that belongs to another library', {
    tsFiles: [CARD, file('src/page.ts', "import { css } from 'other-lib';\nexport const s = css`.my-card { }`;")],
  });

  test('kept when a stylesheet imported from a package mentions it', () => {
    const input: Partial<SelectorPlanInput> = {
      tsFiles: [CARD, file('src/page.ts', "import theme from 'some-theme/theme.css';")],
      readExternalStylesheet: (specifier) => (specifier === 'some-theme/theme.css' ? '.my-card { }' : undefined),
    };
    expect(plan(input).get('my-card')).toBeUndefined();
    expect(plan({ ...input, readExternalStylesheet: () => '.unrelated { }' }).get('my-card')).toBe('a-a');
  });

  test('module specifiers do not count: the bundler consumes them', () => {
    const map = plan({
      tsFiles: [
        CARD,
        file(
          'src/routes.ts',
          "import { MyCard } from './my-card.js';\nexport { MyCard } from './my-card.js';\nexport const load = () => import('./my-card.js');",
        ),
      ],
    });
    expect(map.get('my-card')).toBe('a-a');
  });

  test('comments in TypeScript do not count: they are never emitted', () => {
    const map = plan({ tsFiles: [CARD, file('src/note.ts', '// see my-card\n/* my-card */\nexport const x = 1;')] });
    expect(map.get('my-card')).toBe('a-a');
  });

  test('a single-word selector is never renamed', () => {
    const map = planSelectorRenames({
      selectors: ['card'],
      tsFiles: [
        file('src/card.ts', "export const Card = defineComponent('card', () => ({ template: html`<b>x</b>` }));"),
      ],
      cssFiles: [],
      html: '',
    });
    expect(map.size).toBe(0);
  });

  test('a generated name that already means something is skipped', () => {
    const map = plan({
      reserved: ['a-a'],
      tsFiles: [CARD, file('src/page.ts', 'export const t = html`<div class="a-b"></div>`;')],
    });
    expect(map.get('my-card')).toBe('a-c');
  });

  test('one unsafe selector does not stop the others', () => {
    const map = planSelectorRenames({
      selectors: ['my-card', 'my-list'],
      tsFiles: [
        CARD,
        file('src/list.ts', 'export const MyList = defineComponent(() => ({ template: html`<ul></ul>` }));'),
        file('src/routes.ts', "export const path = '/my-list';"),
      ],
      cssFiles: [],
      html: '',
    });
    expect(map.get('my-card')).toBe('a-a');
    expect(map.get('my-list')).toBeUndefined();
  });
});

describe('renameSelectorsInHtml', () => {
  test('renames tags and leaves everything else in the document alone', () => {
    const map = new SelectorMap();
    map.register('my-app');
    map.register('my-app-shell');
    const html = '<title>my-app</title><my-app class="my-app"></my-app><my-app-shell/><p>my-app</p>';
    expect(renameSelectorsInHtml(html, map)).toBe('<title>my-app</title><a-a class="my-app"></a-a><a-b/><p>my-app</p>');
  });
});
