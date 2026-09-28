import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { PluginBuild } from 'esbuild';
import { join, relative } from 'node:path';
import { runBuild } from '../../cli/build.js';
import { createTempProject, createTestBuildConfig, removeTempProject } from '../../testing/build-project.js';
import { PostBuildPlugin } from './post-build-processor.js';

const APP = `
import { defineComponent, mount } from 'thane';

export const App = defineComponent('test-app', () => ({
  template: html\`<div>x</div>\`,
}));
mount({ component: App });
`;

const ENTRY_SCRIPT = /<script type="module" src="\/main-[A-Z0-9]+\.js"><\/script>/;

describe('Entry script injection', () => {
  test('an absolute entry path (as a config file produces) still gets its script tag', async () => {
    const project = await createTempProject(APP);
    try {
      await runBuild(createTestBuildConfig(project, { strictTypeCheck: false }));
      expect(await readFile(join(project.outDir, 'index.html'), 'utf8')).toMatch(ENTRY_SCRIPT);
    } finally {
      await removeTempProject(project);
    }
  });

  test('a relative entry path (as a CLI flag produces) gets its script tag', async () => {
    const project = await createTempProject(APP);
    try {
      const entry = `./${relative(process.cwd(), project.entryPath).replace(/\\/g, '/')}`;
      await runBuild(createTestBuildConfig(project, { entryPoints: [entry], strictTypeCheck: false }));
      expect(await readFile(join(project.outDir, 'index.html'), 'utf8')).toMatch(ENTRY_SCRIPT);
    } finally {
      await removeTempProject(project);
    }
  });
});

describe('an edited index.html is rendered like the built one', () => {
  const SOURCE_HTML =
    '<!doctype html>\n<html>\n  <head>\n    <!-- a note -->\n    <title>t</title>\n  </head>\n  <body>\n    <div id="app"></div>\n  </body>\n</html>\n';

  /** Run the plugin's onEnd for one built entry, edit index.html, and return both renders. */
  const renderBeforeAndAfterEdit = async (isProd: boolean) => {
    const root = await mkdtemp(join(tmpdir(), 'thane-h26-'));
    const distDir = join(root, 'dist');
    const htmlPath = join(root, 'index.html');
    const outputHtml = join(distDir, 'index.html');
    const entry = join(root, 'src', 'main.ts');
    await mkdir(distDir, { recursive: true });
    await writeFile(htmlPath, SOURCE_HTML);
    await writeFile(join(distDir, 'main-ABC123.js'), 'console.log(1);');
    const hooks: { end?: (result: unknown) => Promise<void>; dispose?: () => void } = {};
    const plugin = PostBuildPlugin({
      distDir,
      inputHTMLFilePath: htmlPath,
      outputHTMLFilePath: outputHtml,
      entryPoints: [entry],
      serve: true,
      isProd,
      port: 0,
      host: 'localhost',
      emptyOutDir: false,
    });
    void plugin.setup({
      onStart: () => {},
      onEnd: (callback: (result: unknown) => Promise<void>) => (hooks.end = callback),
      onDispose: (callback: () => void) => (hooks.dispose = callback),
    } as unknown as PluginBuild);
    const info = console.info;
    console.info = () => {};
    try {
      await hooks.end!({
        metafile: { inputs: {}, outputs: { 'dist/main-ABC123.js': { bytes: 15, entryPoint: entry } } },
      });
      const built = await readFile(outputHtml, 'utf8');
      await writeFile(htmlPath, SOURCE_HTML.replace('<title>t</title>', '<title>t</title>\n    <meta name="edited">'));
      let edited = built;
      for (let i = 0; i < 100 && !edited.includes('edited'); i++) {
        await Bun.sleep(50);
        edited = await readFile(outputHtml, 'utf8');
      }
      return { built, edited };
    } finally {
      hooks.dispose?.();
      console.info = info;
      await rm(root, { recursive: true, force: true });
    }
  };

  test('thane serve --prod: the output stays minified', async () => {
    const { built, edited } = await renderBeforeAndAfterEdit(true);
    expect(built).not.toContain('\n');
    expect(built).not.toContain('a note');
    expect(edited).toBe(built.replace('<title>t</title>', '<title>t</title><meta name="edited">'));
  }, 20000);

  test('thane dev: the output keeps the relay script, and is not minified', async () => {
    const { built, edited } = await renderBeforeAndAfterEdit(false);
    expect(built).toContain('/__thane-browser-events');
    expect(built).toContain('\n    <!-- a note -->');
    expect(edited).toBe(built.replace('<title>t</title>', '<title>t</title>\n    <meta name="edited">'));
  }, 20000);
});
