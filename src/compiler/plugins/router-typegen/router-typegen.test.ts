import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBuild } from '../../cli/build.js';
import { createTempProject, createTestBuildConfig, removeTempProject } from '../../testing/build-project.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ESNext',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    lib: ['ESNext', 'DOM'],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
  include: ['./src/**/*.ts', './.thane/types/**/*.d.ts'],
});

const MAIN = `
import { mount } from 'thane';
import Routes from './routes.js';

mount({ router: { routes: Routes } });
`;

// Lazy loaders with an inferred return type: the page types flow into the type of Routes
const ROUTES = `
import { defineRoutes } from 'thane/router';

const Routes = defineRoutes({
  '/': { component: () => import('./pages/home.js').then((m) => m.HomePage) },
  '/about': { component: () => import('./pages/about.js').then((m) => m.AboutPage) },
  notFound: { component: () => import('./pages/home.js').then((m) => m.HomePage) },
});

export default Routes;
`;

const page = (exportName: string, target: string): string => `
import { defineComponent } from 'thane';

export const ${exportName} = defineComponent(() => ({
  template: html\`<a href="${target}" @click.prevent=\${navigate('${target}')}>go</a>\`,
}));
`;

const buildRoutedProject = async (homeTarget: string): Promise<string> => {
  const project = await createTempProject(MAIN, {
    'tsconfig.json': TSCONFIG,
    'src/routes.ts': ROUTES,
    'src/pages/home.ts': page('HomePage', homeTarget),
    'src/pages/about.ts': page('AboutPage', '/'),
  });
  try {
    await runBuild(createTestBuildConfig(project));
    return await readFile(join(project.root, '.thane', 'types', 'router', 'src', 'routes.generated.d.ts'), 'utf8');
  } finally {
    await removeTempProject(project);
  }
};

describe('Generated route types', () => {
  test('a lazy page that calls navigate() in its template type-checks without annotations', async () => {
    const generated = await buildRoutedProject('/about');
    // The paths are written out as literals: importing the type of Routes would make every
    // page that calls navigate() depend on its own type through the route table.
    expect(generated).toContain("routePaths: '/' | '/about';");
    expect(generated).not.toContain('import type Routes');
  });

  test('navigate() still rejects a path that is not in the route table', async () => {
    await expect(buildRoutedProject('/missing')).rejects.toThrow();
  });
});
