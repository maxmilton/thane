/**
 * Characterisation of setup return-object shapes, compiled end to end (F0-2 item 4, before
 * CE-1, CE-3 and IF-5).
 *
 * For each shape of `defineComponent` setup function this pins, in the development bundle:
 * which registration function is used (lean or full), what is left of the return object(s)
 * after dead properties are stripped, which template becomes `__tpl`, and whether
 * `__enableComponentStyles` is called and imported. Several shapes show defects; they are
 * pinned as they are today and named in the test titles.
 */
import { describe, expect, test } from 'bun:test';
import { buildAndReadJs } from '../../testing/build-project.js';

interface Compiled {
  /** The registration statement, from `var App =` to the end of the call */
  registration: string;
  /** The compiled component template */
  tpl: string;
  /** `__enableComponentStyles();` is emitted */
  stylesCall: boolean;
  /** `__enableComponentStyles` is bundled, i.e. it was imported */
  stylesImported: boolean;
}

const compile = async (declaration: string): Promise<Compiled> => {
  const js = await buildAndReadJs(`import { defineComponent, mount } from 'thane';
const log = (m: string) => console.log(m);
const flag = Math.random() > 2;
${declaration}
mount({ component: App });
`);
  const start = js.indexOf('var App = ');
  const end = js.indexOf(', __tpl);', start);
  if (start === -1 || end === -1) throw new Error(`registration not found in:\n${js}`);
  return {
    registration: js.slice(start, end + ', __tpl);'.length),
    tpl: /var __tpl = _T\(`([^`]*)`\);/.exec(js)?.[1] ?? '<none>',
    stylesCall: js.includes('__enableComponentStyles();'),
    stylesImported: /function __enableComponentStyles\(/.test(js),
  };
};

describe('setup shapes: concise and block bodies', () => {
  test('concise body: lean, template stripped', async () => {
    const r = await compile('export const App = defineComponent(() => ({ template: html`<p>a</p>` }));');
    expect(r.registration).toBe('var App = __registerComponentLean("app", () => ({}), __tpl);');
    expect(r.tpl).toBe('<p>a</p>');
    expect([r.stylesCall, r.stylesImported]).toEqual([false, false]);
  });

  test('block body: lean, template stripped', async () => {
    const r = await compile(`export const App = defineComponent(() => {
  const n = 1;
  return { template: html\`<p>a</p>\` };
});`);
    expect(r.registration).toBe(
      ['var App = __registerComponentLean("app", () => {', '  const n = 1;', '  return {};', '}, __tpl);'].join('\n'),
    );
  });

  test('bindings: __b is the first property of the return object, in both body shapes', async () => {
    const block = await compile(`export const App = defineComponent(() => {
  const n = 1;
  return { template: html\`<p>\${n}</p>\`, onMount: () => { log('m'); } };
});`);
    expect(
      block.registration.startsWith(
        'var App = __registerComponent("app", () => {\n  const n = 1;\n  return {\n    __b: (ctx) => {\n',
      ),
    ).toBe(true);
    expect(block.registration.endsWith('    },\n    onMount: () => {\n      log("m");\n    }\n  };\n}, __tpl);')).toBe(
      true,
    );

    const concise = await compile(`export const App = defineComponent(() => ({
  template: html\`<p>\${flag}</p>\`,
  onMount: () => { log('m'); },
}));`);
    expect(concise.registration.startsWith('var App = __registerComponent("app", () => ({\n  __b: (ctx) => {\n')).toBe(
      true,
    );
    expect(concise.registration.endsWith('  },\n  onMount: () => {\n    log("m");\n  }\n}), __tpl);')).toBe(true);
  });

  test('function expression setup: full with a non-empty onMount', async () => {
    const r = await compile(`export const App = defineComponent(function () {
  return { template: html\`<p>a</p>\`, onMount: () => { log('m'); } };
});`);
    expect(r.registration).toBe(
      [
        'var App = __registerComponent("app", function() {',
        '  return { onMount: () => {',
        '    log("m");',
        '  } };',
        '}, __tpl);',
      ].join('\n'),
    );
  });

  test('explicit selector: the setup is the second argument', async () => {
    const r = await compile(
      "export const App = defineComponent('x-app', () => ({ template: html`<p>a</p>`, onMount: () => {} }));",
    );
    expect(r.registration).toBe('var App = __registerComponentLean("x-app", () => ({}), __tpl);');
  });
});

describe('setup shapes: parenthesised bodies', () => {
  test('parenthesised twice with a non-empty onMount: full, template stripped', async () => {
    const r = await compile(`export const App = defineComponent(() => (({
  template: html\`<p>a</p>\`,
  onMount: () => { log('m'); },
})));`);
    expect(r.registration).toBe(
      [
        'var App = __registerComponent("app", () => ({',
        '  onMount: () => {',
        '    log("m");',
        '  }',
        '}), __tpl);',
      ].join('\n'),
    );
  });

  test('parenthesised twice with styles: full, styles called and imported (H-33)', async () => {
    // Before CE-3 the import came from an early styles walk that looked through one level of
    // parentheses only, while the call followed the strip pass, which unwraps any number: the
    // module called `__enableComponentStyles` without importing it (ReferenceError at mount).
    const r = await compile(`export const App = defineComponent(() => (({
  template: html\`<p>a</p>\`,
  styles: css\`p { color: red; }\`,
})));`);
    expect(r.registration).toBe(
      ['var App = __registerComponent("app", () => ({', '  styles: `p { color: red; }`', '}), __tpl);'].join('\n'),
    );
    expect([r.stylesCall, r.stylesImported]).toEqual([true, true]);
  });

  test('parenthesised once with styles: full, styles called and imported', async () => {
    const r = await compile(`export const App = defineComponent(() => ({
  template: html\`<p>a</p>\`,
  styles: css\`p { color: red; }\`,
}));`);
    expect(r.registration).toBe(
      ['var App = __registerComponent("app", () => ({', '  styles: `p { color: red; }`', '}), __tpl);'].join('\n'),
    );
    expect([r.stylesCall, r.stylesImported]).toEqual([true, true]);
  });
});

describe('setup shapes: styles', () => {
  test('styles shorthand: full, kept, styles called and imported', async () => {
    const r = await compile(`const styles = css\`p { color: red; }\`;
export const App = defineComponent(() => ({ template: html\`<p>a</p>\`, styles }));`);
    expect(r.registration).toBe('var App = __registerComponent("app", () => ({ styles }), __tpl);');
    expect([r.stylesCall, r.stylesImported]).toEqual([true, true]);
  });
});

describe('setup shapes: lifecycle hooks', () => {
  test('empty onMount and onDestroy (a comment is not a statement): both stripped, lean', async () => {
    const r = await compile(`export const App = defineComponent(() => ({
  template: html\`<p>a</p>\`,
  onMount: () => {},
  onDestroy: () => { /* nothing */ },
}));`);
    expect(r.registration).toBe('var App = __registerComponentLean("app", () => ({}), __tpl);');
  });

  test('empty onMount with a non-empty onDestroy: the empty one is stripped, full', async () => {
    const r = await compile(`export const App = defineComponent(() => ({
  template: html\`<p>a</p>\`,
  onMount: () => {},
  onDestroy: () => { log('d'); },
}));`);
    expect(r.registration).toBe(
      [
        'var App = __registerComponent("app", () => ({',
        '  onDestroy: () => {',
        '    log("d");',
        '  }',
        '}), __tpl);',
      ].join('\n'),
    );
  });

  test('a concise-body hook counts as non-empty: full', async () => {
    const r = await compile(`export const App = defineComponent(() => ({
  template: html\`<p>a</p>\`,
  onMount: () => log('m'),
}));`);
    expect(r.registration).toBe(
      ['var App = __registerComponent("app", () => ({', '  onMount: () => log("m")', '}), __tpl);'].join('\n'),
    );
  });
});

describe('setup shapes: several return statements and nested functions', () => {
  test('return inside if: the last template becomes __tpl; features and stripping come from the first return (defect)', async () => {
    // Every return object's template is compiled and blanked, `__tpl` is the last one, and the
    // strip pass works on the first `return {…}` it meets. With `flag` true this component
    // renders "b" with the first branch's onMount.
    const r = await compile(`export const App = defineComponent(() => {
  if (flag) {
    return { template: html\`<p>a</p>\`, onMount: () => { log('a'); } };
  }
  return { template: html\`<p>b</p>\` };
});`);
    expect(r.tpl).toBe('<p>b</p>');
    expect(r.registration).toBe(
      [
        'var App = __registerComponent("app", () => {',
        '  if (flag) {',
        '    return { onMount: () => {',
        '      log("a");',
        '    } };',
        '  }',
        '  return { template: `` };',
        '}, __tpl);',
      ].join('\n'),
    );
  });

  test('styles only in a later return: lean, never called, styles silently dropped (defect)', async () => {
    const r = await compile(`export const App = defineComponent(() => {
  if (flag) {
    return { template: html\`<p>a</p>\` };
  }
  return { template: html\`<p>b</p>\`, styles: css\`p { color: red; }\` };
});`);
    expect(r.registration.startsWith('var App = __registerComponentLean("app", () => {')).toBe(true);
    expect(r.registration).toContain('return { template: ``, styles: `p { color: red; }` };');
    // Detection reads the first return only (before CE-3 an early walk imported
    // __enableComponentStyles anyway, and esbuild dropped the unused import)
    expect([r.stylesCall, r.stylesImported]).toEqual([false, false]);
  });

  test('nested arrow and function expression returns are skipped; a function declaration is not (P8, H-07)', async () => {
    // The strip pass takes `{ a: 1 }` from `function decl()` as the return object: no lifecycle is
    // found, the registration is lean, the real return keeps `template: ``` and onMount never runs.
    const r = await compile(`export const App = defineComponent(() => {
  const arrow = () => ({ template: 1 });
  const fexpr = function () { return { styles: 'x' }; };
  function decl() { return { a: 1 }; }
  void arrow; void fexpr; void decl;
  return { template: html\`<p>a</p>\`, onMount: () => { log('m'); } };
});`);
    expect(r.tpl).toBe('<p>a</p>');
    expect(r.registration).toBe(
      [
        'var App = __registerComponentLean("app", () => {',
        '  const arrow = () => ({ template: 1 });',
        '  const fexpr = function() {',
        '    return { styles: "x" };',
        '  };',
        '  function decl() {',
        '    return { a: 1 };',
        '  }',
        '  void arrow;',
        '  void fexpr;',
        '  void decl;',
        '  return { template: ``, onMount: () => {',
        '    log("m");',
        '  } };',
        '}, __tpl);',
      ].join('\n'),
    );
  });

  test('nested arrow and function expression returns before the real one: skipped, full', async () => {
    const r = await compile(`export const App = defineComponent(() => {
  const arrow = () => ({ onMount: 1 });
  const fexpr = function () { return { styles: 'x' }; };
  void arrow; void fexpr;
  return { template: html\`<p>a</p>\`, onMount: () => { log('m'); } };
});`);
    expect(r.registration).toContain('var App = __registerComponent("app", () => {');
    expect(r.registration).toContain('  return { onMount: () => {');
    expect([r.stylesCall, r.stylesImported]).toEqual([false, false]);
  });
});
