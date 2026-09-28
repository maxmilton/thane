/**
 * The compiled component imports exactly what its registration uses (CE-3, H-33): the
 * registration function it calls (lean or full), and `__enableComponentStyles` exactly when it
 * calls it. Checked on transformDefineComponentSource's output, before esbuild could drop an
 * unused import.
 */
import { describe, expect, test } from 'bun:test';
import { transformDefineComponentSource } from './index.js';

let fileId = 0;

const compile = (setup: string) => {
  const source = `import { defineComponent } from 'thane';
const log = (m: string) => console.log(m);
const flag = Math.random() > 2;
export const App = defineComponent(${setup});
`;
  const out = transformDefineComponentSource(source, `/virtual/registration-${fileId++}.ts`);
  if (out === null) throw new Error('not compiled');
  const runtimeImport = out.split('\n').find((line) => line.includes("from 'thane/runtime'")) ?? '';
  const names = /\{([^}]*)\}/.exec(runtimeImport)?.[1] ?? '';
  const imported = new Set(names.split(',').map((s) => s.trim()));
  const called = /\b(__registerComponent(?:Lean)?)\(/.exec(out)?.[1];
  return { out, imported, called, stylesCalled: out.includes('__enableComponentStyles();') };
};

const expectImportsFollowCalls = (r: ReturnType<typeof compile>) => {
  expect(r.out).not.toContain('__REGISTER_PLACEHOLDER__');
  expect(r.called).toBeDefined();
  expect(r.imported.has(r.called!)).toBe(true);
  const other = r.called === '__registerComponent' ? '__registerComponentLean' : '__registerComponent';
  expect(r.imported.has(other)).toBe(false);
  expect(r.imported.has('__enableComponentStyles')).toBe(r.stylesCalled);
};

describe('registration import follows the registration call', () => {
  test('lean: no styles, no lifecycle', () => {
    const r = compile('() => ({ template: html`<p>a</p>` })');
    expectImportsFollowCalls(r);
    expect([r.called, r.stylesCalled]).toEqual(['__registerComponentLean', false]);
  });

  test('full: a non-empty onMount', () => {
    const r = compile("() => ({ template: html`<p>a</p>`, onMount: () => { log('m'); } })");
    expectImportsFollowCalls(r);
    expect([r.called, r.stylesCalled]).toEqual(['__registerComponent', false]);
  });

  test('lean: empty hooks are stripped and do not count', () => {
    const r = compile('() => ({ template: html`<p>a</p>`, onMount: () => {}, onDestroy: () => {} })');
    expectImportsFollowCalls(r);
    expect([r.called, r.stylesCalled]).toEqual(['__registerComponentLean', false]);
  });

  for (const [label, open, close] of [
    ['parenthesised once', '(', ')'],
    ['parenthesised twice (H-33)', '((', '))'],
    ['parenthesised three times', '(((', ')))'],
  ] as const) {
    test(`styles, concise body ${label}: full, called and imported`, () => {
      const r = compile(`() => ${open}{ template: html\`<p>a</p>\`, styles: css\`p { color: red; }\` }${close}`);
      expectImportsFollowCalls(r);
      expect([r.called, r.stylesCalled]).toEqual(['__registerComponent', true]);
    });
  }

  test('styles shorthand in a block body: full, called and imported', () => {
    const r = compile(`() => {
  const styles = css\`p { color: red; }\`;
  return { template: html\`<p>a</p>\`, styles };
}`);
    expectImportsFollowCalls(r);
    expect([r.called, r.stylesCalled]).toEqual(['__registerComponent', true]);
  });

  test('styles only in a later return: detection reads the last return (H-07), so called and imported', () => {
    const r = compile(`() => {
  if (flag) {
    return { template: html\`<p>a</p>\` };
  }
  return { template: html\`<p>b</p>\`, styles: css\`p { color: red; }\` };
}`);
    expectImportsFollowCalls(r);
    expect([r.called, r.stylesCalled]).toEqual(['__registerComponent', true]);
  });
});
