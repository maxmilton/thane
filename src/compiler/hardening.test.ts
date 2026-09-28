/**
 * Compile-time defects found by probing e4a17f1 (C1–C8).
 *
 * Each test asserts the correct behaviour and stays `test.todo` until the task named in its title
 * fixes the defect; that task turns it into `test`. The runtime defects are in
 * e2e/tests/hardening.spec.ts (`test.fixme`), R1/R2 in src/runtime/hardening.test.ts.
 *
 * `bun test --todo src/compiler/hardening.test.ts` runs the open items: a todo that fails is listed as
 * todo, a todo that passes is reported as a failure ("Remove `.todo`"), which means it has been fixed.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { runBuild } from './cli/build.js';
import {
  buildAndReadJs,
  createTempProject,
  createTestBuildConfig,
  readBuiltJs,
  removeTempProject,
} from './testing/build-project.js';

const DEV = { config: { strictTypeCheck: false } };

const component = (name: string, body: string): string =>
  `import { defineComponent, signal } from 'thane';\nexport const ${name} = defineComponent(() => {\n${body}\n});\n`;

const mainFor = (name: string, file: string): string =>
  `import { mount } from 'thane';\nimport { ${name} } from './${file}.js';\nmount({ component: ${name}, target: document.getElementById('app')! });\n`;

/**
 * Names the bundle reads but never declares, other than browser globals: each one is a
 * `ReferenceError` waiting to happen. The bundle is checked as JavaScript against the ES and DOM libs.
 */
const undeclaredNames = (js: string): string[] => {
  const fileName = '/hardening/bundle.js';
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  const fileExists = host.fileExists;
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === fileName
      ? ts.createSourceFile(name, js, languageVersion, true, ts.ScriptKind.JS)
      : getSourceFile.call(host, name, languageVersion, ...rest);
  host.fileExists = (name) => name === fileName || fileExists.call(host, name);
  const program = ts.createProgram([fileName], options, host);
  return program
    .getSemanticDiagnostics(program.getSourceFile(fileName))
    .filter((d) => d.code === 2304 || d.code === 2552) // Cannot find name 'x' (… Did you mean 'y'?)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n').match(/'([^']+)'/)?.[1] ?? '?');
};

/** The runtime `defineComponent` is called: the component shipped uncompiled. */
const callsRuntimeDefineComponent = (js: string): boolean => /(?<!function\s+)\bdefineComponent\s*\(/.test(js);

describe('F0-3 compile-time defects (turned on by the task in each title)', () => {
  test('H-08 C1 a doc comment mentioning defineComponent() above the component leaves the component intact', async () => {
    const js = await buildAndReadJs(mainFor('Cmt', 'cmt'), {
      ...DEV,
      extraFiles: {
        'src/cmt.ts':
          "import { defineComponent, signal } from 'thane';\n" +
          '/** Built with defineComponent() like every component. */\n' +
          'export const Cmt = defineComponent(() => {\n' +
          '  const n = signal(1);\n' +
          '  return { template: html`<p class="c1">${n()}</p>` };\n' +
          '});\n',
      },
    });
    expect(undeclaredNames(js)).toEqual([]);
    expect(callsRuntimeDefineComponent(js)).toBe(false);
  });

  test('H-09 C2 a component whose path contains "scripts" is compiled', async () => {
    const js = await buildAndReadJs(mainFor('Tr', 'transcripts/tr'), {
      ...DEV,
      extraFiles: {
        'src/transcripts/tr.ts': component(
          'Tr',
          '  const n = signal(2);\n  return { template: html`<p class="c2">${n()}</p>` };',
        ),
      },
    });
    expect(callsRuntimeDefineComponent(js)).toBe(false);
    expect(undeclaredNames(js)).toEqual([]);
  });

  test('H-10 C3 a component file importing thane/router before thane builds', async () => {
    const js = await buildAndReadJs(mainFor('Rt', 'rt'), {
      ...DEV,
      extraFiles: {
        'src/rt.ts':
          "import { navigate } from 'thane/router';\n" +
          "import { defineComponent, signal } from 'thane';\n" +
          'export const Rt = defineComponent(() => {\n' +
          '  const n = signal(3);\n' +
          "  const go = () => navigate('/x');\n" +
          '  return { template: html`<p class="c3" @click=${go}>${n()}</p>` };\n' +
          '});\n',
      },
    });
    expect(callsRuntimeDefineComponent(js)).toBe(false);
    expect(undeclaredNames(js)).toEqual([]);
  });

  test('H-11 C4 a style binding of a CSS custom property to a bare signal builds and sets the property', async () => {
    const js = await buildAndReadJs(mainFor('Cp', 'cp'), {
      ...DEV,
      extraFiles: {
        'src/cp.ts': component(
          'Cp',
          '  const w = signal(\'10px\');\n  return { template: html`<p class="c4" style="--w: ${w()}">c4</p>` };',
        ),
      },
    });
    expect(js).toMatch(/\.setProperty\(\s*["']--w["']/);
    expect(undeclaredNames(js)).toEqual([]);
  });

  test('H-12 C5 braces inside a string inside a template expression build', async () => {
    const js = await buildAndReadJs(mainFor('Br', 'br'), {
      ...DEV,
      extraFiles: {
        'src/br.ts': component(
          'Br',
          "  const on = signal(true);\n  return { template: html`<p class=\"c5\">${on() ? '}' : '{'}</p>` };",
        ),
      },
    });
    expect(js).toMatch(/\?\s*["']\}["']\s*:\s*["']\{["']/);
    expect(undeclaredNames(js)).toEqual([]);
  });

  test('H-13 C6 an entry with two mount() calls on different targets defines mount for both', async () => {
    const js = await buildAndReadJs(
      "import { mount } from 'thane';\n" +
        "import { Mo } from './mo.js';\n" +
        "mount({ component: Mo, target: document.getElementById('app')! });\n" +
        "mount({ component: Mo, target: document.getElementById('app2')! });\n",
      {
        ...DEV,
        extraFiles: {
          'src/mo.ts':
            'import { defineComponent } from \'thane\';\nexport const Mo = defineComponent(() => ({ template: html`<p class="c6">m</p>` }));\n',
        },
      },
    );
    expect(undeclaredNames(js)).toEqual([]);
  });

  test("H-14 C7 importing an .scss file fails with esbuild's no-loader error", async () => {
    await expect(
      buildAndReadJs(mainFor('Sc', 'sc'), {
        ...DEV,
        extraFiles: {
          'src/sc.ts':
            "import { defineComponent } from 'thane';\n" +
            "import styles from './sc.scss';\n" +
            'export const Sc = defineComponent(() => ({ template: html`<p class="c7">s</p>`, styles }));\n',
          'src/sc.scss': '$c: red; .c7 { color: $c; }',
        },
      }),
    ).rejects.toThrow(/No loader is configured for "\.scss" files/);
  });

  test('H-15 C8 building from a working directory outside the project gives the same output', async () => {
    // The same project built twice: from the repository (an ancestor of the project), then from a
    // folder that is not an ancestor. Child components must be compiled and the entry script injected
    // either way.
    // The child's name is unique in the repository: components are looked up by name over the whole
    // scan, so a `Kid` elsewhere in the repository (e2e/hardening-app) would lend it its selector in
    // the build from the repository (a finding of H-15, not fixed here).
    const project = await createTempProject(mainFor('Par', 'par'), {
      'src/par.ts':
        "import { defineComponent } from 'thane';\n" +
        "import { CwdKid } from './kid.js';\n" +
        'export const Par = defineComponent(() => ({ template: html`<div class="par">${CwdKid({})}</div>` }));\n',
      'src/kid.ts':
        'import { defineComponent } from \'thane\';\nexport const CwdKid = defineComponent(() => ({ template: html`<b class="kid">kid</b>` }));\n',
    });
    const outside = await mkdtemp(join(tmpdir(), 'thane-cwd-'));
    const previousCwd = process.cwd();
    const build = async () => {
      await runBuild(createTestBuildConfig(project, DEV.config));
      return {
        // esbuild's `// <file>` markers name each module relative to the working directory
        js: (await readBuiltJs(project.outDir)).replace(/^\/\/(# sourceMappingURL=| ).*$/gm, ''),
        html: await readFile(join(project.outDir, 'index.html'), 'utf8'),
      };
    };
    try {
      const inside = await build();
      process.chdir(outside);
      const fromOutside = await build();
      process.chdir(previousCwd);

      expect(inside.html).toMatch(/<script type="module" src="\/main-[A-Z0-9]+\.js"><\/script>/);
      expect(fromOutside.html).toMatch(/<script type="module" src="\/main-[A-Z0-9]+\.js"><\/script>/);
      expect(fromOutside.js).toBe(inside.js);
    } finally {
      process.chdir(previousCwd);
      await removeTempProject(project);
      await rm(outside, { recursive: true, force: true });
    }
  });
});
