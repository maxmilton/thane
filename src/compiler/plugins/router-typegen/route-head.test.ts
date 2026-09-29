/**
 * What the compiler reads of the routes' heads: static values (for each route's own index.html),
 * whether an app needs head support at all, and the value types of custom fields.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModuleResolver } from '../../utils/module-graph.js';
import { readRouteTableHeads, routePages, routeTablesOf, withHead } from './route-head.js';

let root = '';
let n = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'thane-route-head-'));
  writeFileSync(join(root, 'package.json'), '{}');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A project of its own in `root`: its files, and the path of `src/routes.ts` */
const project = (files: Record<string, string>): { dir: string; routes: string } => {
  const dir = join(root, `p${n++}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return { dir, routes: join(dir, 'src', 'routes.ts') };
};

const read = async (routesSource: string, extra: Record<string, string> = {}) => {
  const { dir, routes } = project({ 'src/routes.ts': routesSource, ...extra });
  const [table] = await readRouteTableHeads(routes, createModuleResolver(dir));
  return table!;
};

const PAGE = "component: () => import('./page.js')";

describe('static values', () => {
  test('literals, templates, concatenation, spreads, consts in the file and imported from another', async () => {
    const table = await read(
      [
        "import { defineRoutes } from 'thane/router';",
        "import { SITE_NAME, SHARED } from './site.js';",
        "const BASE = 'https://example.com';",
        'export default defineRoutes(',
        '  {',
        `    '/': { ${PAGE}, meta: { description: \`Welcome to \${SITE_NAME}\`, ...SHARED } },`,
        `    '/about': { ${PAGE}, meta: { title: 'About ' + SITE_NAME, image: { url: '/a.png', width: 1200 } } as const },`,
        `    notFound: { ${PAGE}, meta: { title: 'Missing', robots: 'noindex' } },`,
        '  },',
        '  { meta: { siteUrl: BASE, titleTemplate: `%s | ${SITE_NAME}`, twitter: { site: SHARED.handle } } },',
        ');',
      ].join('\n'),
      {
        'src/site.ts':
          "export const SITE_NAME = 'Example';\nexport const SHARED = { handle: '@ex', locale: 'en_ZA' };\n",
      },
    );
    expect(table.site).toEqual({
      siteUrl: 'https://example.com',
      titleTemplate: '%s | Example',
      twitter: { site: '@ex' },
    });
    expect(table.routes).toEqual([
      { path: '/', meta: { description: 'Welcome to Example', handle: '@ex', locale: 'en_ZA' } },
      { path: '/about', meta: { title: 'About Example', image: { url: '/a.png', width: 1200 } } },
    ]);
    expect(table.notes).toEqual([]);
  });

  test('a value the source does not give is left out, with a note; a meta function is left to the browser', async () => {
    const table = await read(
      [
        "import { defineRoutes } from 'thane/router';",
        'const today = new Date().toISOString();',
        'export default defineRoutes({',
        `  '/': { ${PAGE}, meta: { title: 'Home', description: today } },`,
        `  '/users/:id': { ${PAGE}, meta: (route) => ({ title: route.params.id }) },`,
        `  notFound: { ${PAGE} },`,
        '});',
      ].join('\n'),
    );
    expect(table.routes).toEqual([
      { path: '/', meta: { title: 'Home' } },
      { path: '/users/:id', meta: null },
    ]);
    expect(table.notes).toEqual([
      '/: meta description not static, applied in the browser only',
      '/users/:id: its meta is computed, applied in the browser only',
    ]);
  });

  test('custom fields: the helpers with their arguments, and functions with the type of their value', async () => {
    const table = await read(
      [
        "import { defineRoutes, metaName, metaProperty, linkTag } from 'thane/router';",
        "import type { Langs } from './types.js';",
        'export interface Local { a: string }',
        'interface Hidden { b: string }',
        'export default defineRoutes(',
        `  { '/': { ${PAGE} }, notFound: { ${PAGE} } },`,
        '  {',
        '    customMeta: {',
        "      author: metaName('author'),",
        "      fbAppId: metaProperty('fb:app_id'),",
        "      feed: linkTag('alternate', { type: 'application/rss+xml' }),",
        '      hreflang: (langs: Langs) => [],',
        '      local: (value: Local[]) => [],',
        '      plain: (value: Record<string, number>) => [],',
        '      hidden: (value: Hidden) => [],',
        '      untyped: (value) => [],',
        '    },',
        '  },',
        ');',
      ].join('\n'),
    );
    const generated = join(root, 'gen', 'routes.generated.d.ts');
    const [typed] = await readRouteTableHeads(
      table.file,
      createModuleResolver(join(table.file, '..', '..')),
      generated,
    );
    expect(typed!.custom).toEqual({
      author: { kind: 'name', id: 'author' },
      fbAppId: { kind: 'property', id: 'fb:app_id' },
      feed: { kind: 'link', rel: 'alternate', attributes: { type: 'application/rss+xml' } },
      hreflang: {
        kind: 'function',
        valueType: expect.stringMatching(/^import\('\.\.\/p\d+\/src\/types\.js'\)\.Langs$/),
      },
      local: {
        kind: 'function',
        valueType: expect.stringMatching(/^import\('\.\.\/p\d+\/src\/routes\.js'\)\.Local\[\]$/),
      },
      plain: { kind: 'function', valueType: 'Record<string, number>' },
      hidden: { kind: 'function', valueType: 'unknown' },
      untyped: { kind: 'function', valueType: 'unknown' },
    });
    expect(typed!.notes).toEqual([
      'customMeta.hidden: its value type names a type that is not exported; setMeta() takes it as unknown',
    ]);
  });
});

describe('whether an app needs head support', () => {
  const uses = async (routesSource: string, extra: Record<string, string> = {}) => {
    const { dir } = project({
      'src/main.ts': "import Routes from './routes.js';\nconsole.log(Routes);\n",
      'src/routes.ts': routesSource,
      ...extra,
    });
    return (await routeTablesOf([join(dir, 'src', 'main.ts')], dir)).usesHead;
  };
  const table = (routes: string, options = '') =>
    `import { defineRoutes } from 'thane/router';\nexport default defineRoutes({ ${routes} }${options});\n`;

  test('titles alone: no', async () => {
    expect(await uses(table(`'/': { ${PAGE}, meta: { title: 'A' } }, notFound: { ${PAGE} }`))).toBe(false);
  });

  test('any other field, options, a meta function, or setMeta anywhere the entry reaches: yes', async () => {
    expect(await uses(table(`'/': { ${PAGE}, meta: { description: 'A' } }, notFound: { ${PAGE} }`))).toBe(true);
    expect(await uses(table(`'/': { ${PAGE} }, notFound: { ${PAGE} }`, ", { meta: { titleTemplate: '%s' } }"))).toBe(
      true,
    );
    expect(await uses(table(`'/': { ${PAGE}, meta: () => ({ title: 'A' }) }, notFound: { ${PAGE} }`))).toBe(true);
    expect(
      await uses(table(`'/': { component: () => import('./page.js') }, notFound: { ${PAGE} }`), {
        'src/page.ts': "import { setMeta } from 'thane/router';\nsetMeta({ title: 'x' });\n",
      }),
    ).toBe(true);
  });

  test('a table the compiler cannot read: yes', async () => {
    expect(
      await uses(
        "import { defineRoutes } from 'thane/router';\nconst t = { '/': {} };\nexport default defineRoutes(t as never);\n",
      ),
    ).toBe(true);
  });

  test("another app's routes the entry does not reach: no", async () => {
    expect(
      await uses(table(`'/': { ${PAGE} }, notFound: { ${PAGE} }`), {
        'src/other/routes.ts': table(`'/': { ${PAGE}, meta: { description: 'x' } }, notFound: { ${PAGE} }`),
      }),
    ).toBe(false);
  });
});

describe('whether an app needs the guard and redirect step', () => {
  const guards = async (routesSource: string) => {
    const { dir } = project({
      'src/main.ts': "import Routes from './routes.js';\nconsole.log(Routes);\n",
      'src/routes.ts': routesSource,
    });
    return (await routeTablesOf([join(dir, 'src', 'main.ts')], dir)).usesGuards;
  };
  const table = (routes: string) =>
    `import { defineRoutes } from 'thane/router';\nexport default defineRoutes({ ${routes} });\n`;

  test('pages alone, titles and heads included: no', async () => {
    expect(await guards(table(`'/': { ${PAGE}, meta: { description: 'A' } }, notFound: { ${PAGE} }`))).toBe(false);
  });

  test('a canEnter or a redirectTo on any route, notFound included, however written: yes', async () => {
    expect(await guards(table(`'/': { ${PAGE}, canEnter: () => true }, notFound: { ${PAGE} }`))).toBe(true);
    expect(await guards(table(`'/old': { redirectTo: '/' }, notFound: { ${PAGE} }`))).toBe(true);
    expect(await guards(table(`'/': { ${PAGE} }, notFound: { redirectTo: '/' }`))).toBe(true);
    expect(await guards(table(`'/': { ${PAGE}, canEnter() { return true; } }, notFound: { ${PAGE} }`))).toBe(true);
    expect(
      await guards(`const canEnter = () => true;\n${table(`'/': { ${PAGE}, canEnter }, notFound: { ${PAGE} }`)}`),
    ).toBe(true);
  });

  test('what the compiler cannot read counts as a guard: a spread, a route or a table in a variable', async () => {
    expect(await guards(`const r = { ${PAGE} };\n${table(`'/': { ...r }, notFound: { ${PAGE} }`)}`)).toBe(true);
    expect(await guards(`const r = { ${PAGE} };\n${table(`'/': r, notFound: { ${PAGE} }`)}`)).toBe(true);
    expect(
      await guards(
        "import { defineRoutes } from 'thane/router';\nconst t = { '/': {} };\nexport default defineRoutes(t as never);\n",
      ),
    ).toBe(true);
  });
});

const INDEX = [
  '<!doctype html><html><head>',
  '<meta charset="utf-8">',
  '<title>Old</title>',
  '<meta name="description" content="old description">',
  '<meta property="og:title" content=\'old\'>',
  '<link rel="icon" href="/favicon.ico">',
  '<script type="application/ld+json">{"old":true}</script>',
  '<script type="module" src="/main.js"></script>',
  '</head><body></body></html>',
].join('');

describe('withHead', () => {
  test('the title and every tag with the same key are replaced; other tags stay', () => {
    const html = withHead(INDEX, {
      title: 'New & improved',
      tags: [
        { meta: { name: 'description', content: 'new' } },
        { meta: { property: 'og:title', content: 'New' } },
        { script: { type: 'application/ld+json', text: '{"new":true}' } },
      ],
    });
    expect(html).toBe(
      [
        '<!doctype html><html><head>',
        '<meta charset="utf-8">',
        '<link rel="icon" href="/favicon.ico">',
        '<script type="module" src="/main.js"></script>',
        '<title>New &amp; improved</title>',
        '<meta name="description" content="new">',
        '<meta property="og:title" content="New">',
        '<script type="application/ld+json">{"new":true}</script>',
        '</head><body></body></html>',
      ].join(''),
    );
  });

  test('a head without a title keeps the one index.html has', () => {
    expect(withHead(INDEX, { title: undefined, tags: [] })).toBe(INDEX);
  });
});

describe('routePages', () => {
  test('every route without parameters, `/` as the root index.html, with its head', async () => {
    const table = await read(
      [
        "import { defineRoutes, metaName } from 'thane/router';",
        'export default defineRoutes(',
        '  {',
        `    '/': { ${PAGE}, meta: { description: 'Home page' } },`,
        `    '/about/team': { ${PAGE}, meta: { title: 'Team', author: 'Ada' } },`,
        `    '/users/:id': { ${PAGE}, meta: { title: 'User' } },`,
        `    notFound: { ${PAGE}, meta: { title: 'Missing' } },`,
        '  },',
        "  { meta: { siteUrl: 'https://example.com', title: 'Example', titleTemplate: '%s | Example' }, customMeta: { author: metaName('author') } },",
        ');',
      ].join('\n'),
    );
    const pages = routePages('<html><head><title>Old</title></head><body></body></html>', table);
    expect(pages.map((page) => page.file)).toEqual(['index.html', 'about/team/index.html']);
    expect(pages[0]!.html).toContain('<title>Example</title><meta name="description" content="Home page">');
    expect(pages[0]!.html).toContain('<link rel="canonical" href="https://example.com/">');
    expect(pages[1]!.html).toContain('<title>Team | Example</title>');
    expect(pages[1]!.html).toContain('<meta property="og:url" content="https://example.com/about/team">');
    expect(pages[1]!.html).toContain('<meta name="author" content="Ada">');
  });
});
