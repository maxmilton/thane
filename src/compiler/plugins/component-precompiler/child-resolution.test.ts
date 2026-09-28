/**
 * A child component call in a template, `${Kid(…)}`, resolves to the component the file declares or
 * imports under that name, whatever other components the project holds: two components with one
 * export name in different folders stay apart, an import alias works, re-exports and tsconfig `paths`
 * are followed, and a plain function that shares a component's name is not a component call.
 */
import { describe, expect, test } from 'bun:test';
import { buildAndReadJs } from '../../testing/build-project.js';

const DEV = { strictTypeCheck: false };

const MAIN =
  "import { mount } from 'thane';\nimport { App } from './app.js';\n" +
  "mount({ component: App, target: document.getElementById('app')! });\n";

/** src/app.ts: a component with the given imports and template content. */
const app = (imports: string, template: string): string =>
  `import { defineComponent } from 'thane';\n${imports}\n` +
  'export const App = defineComponent(() => ({ template: html`<main>' +
  template +
  '</main>` }));\n';

const kid = (selector: string, text: string, name = 'Kid'): string =>
  `import { defineComponent } from 'thane';\n` +
  `export const ${name} = defineComponent('${selector}', () => ({ template: html\`<b>${text}</b>\` }));\n`;

const parent = (name: string, kidPath: string): string =>
  `import { defineComponent } from 'thane';\nimport { Kid } from '${kidPath}';\n` +
  `export const ${name} = defineComponent(() => ({ template: html\`<section>\${Kid({})}</section>\` }));\n`;

const build = (files: Record<string, string>): Promise<string> =>
  buildAndReadJs(MAIN, { extraFiles: files, config: DEV });

describe('child components resolve through the file', () => {
  test('two components with one export name: each parent mounts the one it imports', async () => {
    const js = await build({
      'src/app.ts': app(
        "import { First } from './first.js';\nimport { Second } from './second.js';",
        '${First({})}${Second({})}',
      ),
      'src/a/kid.ts': kid('kid-a', 'A'),
      'src/b/kid.ts': kid('kid-b', 'B'),
      'src/first.ts': parent('First', './a/kid.js'),
      'src/second.ts': parent('Second', './b/kid.js'),
    });
    expect(js).toContain('<kid-a');
    expect(js).toContain('<kid-b');
  });

  test('an import alias names the component', async () => {
    const js = await build({
      'src/app.ts': app("import { Kid as Child } from './kid.js';", '${Child({})}'),
      'src/kid.ts': kid('alias-kid', 'K'),
    });
    expect(js).toContain('<alias-kid');
  });

  test('re-exports are followed: a named re-export and export *', async () => {
    const js = await build({
      'src/app.ts': app("import { Card, Badge } from './ui/index.js';", '${Card({})}${Badge({})}'),
      'src/ui/index.ts': "export { Card } from './card.js';\nexport * from './badge.js';\n",
      'src/ui/card.ts': kid('ui-card', 'C', 'Card'),
      'src/ui/badge.ts': kid('ui-badge', 'B', 'Badge'),
    });
    expect(js).toContain('<ui-card');
    expect(js).toContain('<ui-badge');
  });

  test('a tsconfig paths alias is followed', async () => {
    const js = await build({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          paths: { '@ui/*': ['./src/ui/*'] },
          skipLibCheck: true,
        },
        include: ['src'],
      }),
      'src/app.ts': app("import { Kid } from '@ui/kid.js';", '${Kid({})}'),
      'src/ui/kid.ts': kid('paths-kid', 'P'),
    });
    expect(js).toContain('<paths-kid');
  });

  test('a local function that shares a component name is a plain call', async () => {
    const js = await build({
      'src/app.ts': app('const Label = (s: string): string => s.toUpperCase();', "${Label('x')}"),
      'src/label.ts': kid('x-label', 'L', 'Label'),
    });
    expect(js).not.toContain('x-label');
    expect(js).toContain('toUpperCase');
  });
});
