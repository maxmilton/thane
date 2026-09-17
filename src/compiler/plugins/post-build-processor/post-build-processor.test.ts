import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { runBuild } from '../../cli/build.js';
import { createTempProject, createTestBuildConfig, removeTempProject } from '../../testing/build-project.js';

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
