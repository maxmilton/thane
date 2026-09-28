/**
 * Characterisation of createBuildContext (before CL-3): it scans the working directory, not the
 * project root, skips the excluded folders and .d.ts files, and indexes every exported
 * defineComponent by name and by selector.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createBuildContext } from './file-utils.js';

const FILES: Record<string, string> = {
  'src/main.ts': `import { AppShell } from './app-shell';\nconsole.log(AppShell);\n`,
  'src/app-shell.ts': `export const AppShell = defineComponent(() => ({ template: html\`<p>a</p>\` }));\n`,
  'src/widgets/card.ts': [
    `export const Card = defineComponent('x-card', () => ({ template: html\`<p>c</p>\` }));`,
    `export const Other = defineComponent('x-other', () => ({ template: html\`<p>o</p>\` }));`,
    `const Hidden = defineComponent('x-hidden', () => ({ template: html\`<p>h</p>\` }));`,
    `export const notAComponent = Math.max(1, 2);`,
    '',
  ].join('\n'),
  'src/types.d.ts': `export const Ghost = defineComponent('x-ghost', () => ({ template: html\`\` }));\n`,
  'src/readme.md': 'not scanned\n',
  'node_modules/pkg/index.ts': `export const Nm = defineComponent('x-nm', () => ({ template: html\`\` }));\n`,
  'dist/out.ts': `export const Dist = defineComponent('x-dist', () => ({ template: html\`\` }));\n`,
  '.git/hook.ts': `export const Git = defineComponent('x-git', () => ({ template: html\`\` }));\n`,
  'coverage/c.ts': '',
  'deep/a/b/c/leaf.ts': `export const LeafNode = defineComponent(() => ({ template: html\`\` }));\n`,
};

let root = '';
const originalCwd = process.cwd();

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'thane-build-context-')));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

test('createBuildContext scans the working directory', async () => {
  process.chdir(root);
  let ctx;
  try {
    ctx = await createBuildContext();
  } finally {
    process.chdir(originalCwd);
  }
  const rel = (p: string) => relative(root, p).replace(/\\/g, '/');
  expect(ctx.tsFiles.map(rel).sort()).toEqual([
    'deep/a/b/c/leaf.ts',
    'src/app-shell.ts',
    'src/main.ts',
    'src/widgets/card.ts',
  ]);
  expect(Object.keys(ctx).sort()).toEqual(['componentsByName', 'componentsBySelector', 'tsFiles']);
  const byName = Object.fromEntries([...ctx.componentsByName].map(([k, d]) => [k, [d.selector, rel(d.filePath)]]));
  const bySelector = Object.fromEntries([...ctx.componentsBySelector].map(([k, d]) => [k, [d.name, rel(d.filePath)]]));
  expect(byName).toEqual({
    AppShell: ['app-shell', 'src/app-shell.ts'],
    Card: ['x-card', 'src/widgets/card.ts'],
    Other: ['x-other', 'src/widgets/card.ts'],
    LeafNode: ['leaf-node', 'deep/a/b/c/leaf.ts'],
  });
  expect(bySelector).toEqual({
    'app-shell': ['AppShell', 'src/app-shell.ts'],
    'x-card': ['Card', 'src/widgets/card.ts'],
    'x-other': ['Other', 'src/widgets/card.ts'],
    'leaf-node': ['LeafNode', 'deep/a/b/c/leaf.ts'],
  });
});
