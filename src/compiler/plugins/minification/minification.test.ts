import { describe, expect, test } from 'bun:test';
import { buildAndReadJs, PROD_BUILD } from '../../testing/build-project.js';

const prod = (source: string, extraFiles: Record<string, string> = {}): Promise<string> =>
  buildAndReadJs(source, { extraFiles, config: PROD_BUILD });

const FAKE_LIB: Record<string, string> = {
  'node_modules/fake-lib/package.json': JSON.stringify({
    name: 'fake-lib',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
  }),
  // A template literal that looks like CSS, and a regex holding a quote and a backtick
  'node_modules/fake-lib/index.js': [
    'export const quote = /["`]/;',
    'export const banner = () => `a:   b;   c:   d   { x:   y }`;',
    '',
  ].join('\n'),
};

describe('Production minification', () => {
  test('a chunk built only from node_modules is left exactly as esbuild emitted it', async () => {
    const js = await prod(
      `
import { defineComponent, mount } from 'thane';

export const App = defineComponent('test-app', () => ({
  template: html\`<div>x</div>\`,
}));
mount({ component: App });
void import('fake-lib').then((lib) => {
  document.title = lib.banner() + String(lib.quote);
});
`,
      FAKE_LIB,
    );
    expect(js).toContain('a:   b;   c:   d   { x:   y }');
  });

  test('template literals that are not HTML or CSS keep their whitespace and line breaks', async () => {
    const js = await prod(`
import { defineComponent, mount } from 'thane';

export const App = defineComponent('test-app', () => {
  const code = document.title;
  document.title = ['one', 'two'].join('\\n') + \`Error:   \${code};   retry:   later\`;
  return { template: html\`<div>x</div>\` };
});
mount({ component: App });
`);
    // esbuild prints "\\n" as a template literal holding a real line break
    expect(js).toMatch(/\.join\((?:`\n`|"\\n")\)/);
    expect(js).toMatch(/Error: {3}\$\{\w+\}; {3}retry: {3}later/);
  });

  test('a regex literal holding quotes and backticks does not derail the template scanner', async () => {
    const js = await prod(`
import { defineComponent, mount } from 'thane';

export const App = defineComponent('test-app', () => {
  const splitter = /["\`]/;
  document.title = document.title.split(splitter).join('') + \`keep   this:   as is\`;
  return { template: html\`<div>
    <p>hi</p>
  </div>\` };
});
mount({ component: App });
`);
    expect(js).toContain('keep   this:   as is');
    expect(js).toContain('<div><p>hi</p></div>');
  });

  test('component HTML and CSS are still minified', async () => {
    const js = await prod(`
import { defineComponent, mount } from 'thane';

export const App = defineComponent('test-app', () => ({
  template: html\`
    <section>
      <h1>Title</h1>
      <p>Body   text</p>
    </section>
  \`,
  styles: css\`
    .card {
      padding: 1rem;
      color: red;
    }
  \`,
}));
mount({ component: App });
`);
    expect(js).toContain('<section><h1>Title</h1><p>Body text</p></section>');
    expect(js).toMatch(/\.card\s?\{padding:1rem;color:red;?\}/);
  });
});

describe('Selector minification', () => {
  const CHILD = `
import { defineComponent } from 'thane';

export const ChildCard = defineComponent(() => ({
  template: html\`<b>child</b>\`,
  styles: css\`:host { display: block; }\`,
}));
`;

  test('component selectors are renamed consistently in registration, host creation and CSS', async () => {
    const js = await prod(
      `
import { defineComponent, mount } from 'thane';
import { ChildCard } from './child.js';

export const ParentPage = defineComponent(() => ({
  template: html\`<div>\${ChildCard({})}</div>\`,
  styles: css\`.child-card { margin: 1px; }\`,
}));
mount({ component: ParentPage });
`,
      { 'src/child.ts': CHILD },
    );
    expect(js).not.toContain('child-card');
    expect(js).not.toContain('parent-page');
    const host = js.match(/createElement\("([a-z]+-[a-z]+)"\)/)?.[1];
    expect(host).toBeDefined();
    // the parent's stylesheet addresses the child's host class under its new name
    expect(js).toMatch(new RegExp(`\\.${host!}\\s*\\{\\s*margin`));
  });

  test('a selector that also appears inside other strings is left alone', async () => {
    const js = await prod(
      `
import { defineComponent, mount } from 'thane';
import { ChildCard } from './child.js';

export const ParentPage = defineComponent(() => {
  document.title = '/child-card/details';
  return { template: html\`<div>\${ChildCard({})}</div>\` };
});
mount({ component: ParentPage });
`,
      { 'src/child.ts': CHILD },
    );
    expect(js).toContain('createElement("child-card")');
    expect(js).toContain('/child-card/details');
    expect(js).not.toContain('parent-page');
  });
});
