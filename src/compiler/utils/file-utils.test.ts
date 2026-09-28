/**
 * Characterisation of createBuildContext (before CL-3): it scans the working directory, skips the
 * excluded folders and .d.ts files, and indexes every exported defineComponent by name and by
 * selector. Since H-15 it also scans the project root when that lies outside the working directory.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
  expect(Object.keys(ctx).sort()).toEqual(['components', 'componentsBySelector', 'projectRoot', 'tsFiles']);
  expect(relative(root, ctx.projectRoot)).toBe('');
  const byName = Object.fromEntries(ctx.components.map((d) => [d.name, [d.selector, rel(d.filePath)]]));
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

/** Scanned files relative to `root`, in scan order, for a build started in `cwd`. */
const scanFrom = async (cwd: string, projectRoot?: string): Promise<string[]> => {
  process.chdir(cwd);
  try {
    const ctx = await createBuildContext(projectRoot);
    return ctx.tsFiles.map((p) => relative(root, p).replace(/\\/g, '/'));
  } finally {
    process.chdir(originalCwd);
  }
};

describe('H-15: the project root is scanned too when it lies outside the working directory', () => {
  test('a project root inside the working directory adds nothing', async () => {
    expect(await scanFrom(root, join(root, 'src'))).toEqual(await scanFrom(root));
    expect(await scanFrom(root, root)).toEqual(await scanFrom(root));
  });

  test('a working directory outside the project: its files first, then the project', async () => {
    const files = await scanFrom(join(root, 'deep'), join(root, 'src'));
    expect(files[0]).toBe('deep/a/b/c/leaf.ts');
    expect(files.slice(1).sort()).toEqual(['src/app-shell.ts', 'src/main.ts', 'src/widgets/card.ts']);
  });

  test('a working directory inside the project: each file once', async () => {
    const files = await scanFrom(join(root, 'src', 'widgets'), root);
    expect(files[0]).toBe('src/widgets/card.ts');
    expect(files.slice(1).sort()).toEqual(['deep/a/b/c/leaf.ts', 'src/app-shell.ts', 'src/main.ts']);
  });
});
