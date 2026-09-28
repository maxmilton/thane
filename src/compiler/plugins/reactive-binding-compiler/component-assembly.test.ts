/**
 * transformDefineComponentSource assembles the compiled file from edits positioned on one parse
 * of the source (IF-5, H-08). Text that only mentions `defineComponent(` (a comment, a string,
 * template text) is left alone, and the call itself is renamed however it is written.
 */
import { describe, expect, test } from 'bun:test';
import { transformDefineComponentSource } from './index.js';

let fileId = 0;

const compile = (source: string): string => {
  const out = transformDefineComponentSource(source, `/virtual/assembly-${fileId++}.ts`);
  if (out === null) throw new Error('not compiled');
  return out;
};

/** The one registration call, from its name to the start of the setup function. */
const registrationHead = (out: string): string =>
  /__registerComponent(?:Lean)?\([^)]*?(?=\(|function)/.exec(out)?.[0] ?? '';

describe('component assembly (H-08)', () => {
  test('C1: a doc comment mentioning defineComponent() above the call is left alone', () => {
    const out = compile(`import { defineComponent } from 'thane';
/** Built with defineComponent() like every component. */
export const Cmt = defineComponent(() => ({ template: html\`<p>a</p>\` }));
`);
    expect(out).toContain('/** Built with defineComponent() like every component. */');
    expect(out).toContain("export const Cmt = __registerComponentLean('cmt', () => ({ }), __tpl);");
  });

  test('template text and a string mentioning defineComponent( stay as written', () => {
    const out = compile(`import { defineComponent } from 'thane';
const hint = 'call defineComponent(setup) once per file';
export const Doc = defineComponent(() => ({ template: html\`<code>defineComponent(() => …)</code>\` }));
`);
    expect(out).toContain("const hint = 'call defineComponent(setup) once per file';");
    expect(out).toContain('_T(`<code>defineComponent(() => …)</code>`)');
    expect(out).toContain("export const Doc = __registerComponentLean('doc', () => ({ }), __tpl);");
  });

  test('type arguments containing parentheses are renamed with the call (found in IF-4)', () => {
    // A call signature in the props type: the textual rename stopped at its `(`, so the call
    // stayed `defineComponent<…>(…)`, which the compiled file no longer imports
    const out = compile(`import { defineComponent } from 'thane';
export const Grid = defineComponent<{ rows: { (): number[] }; pick: (n: number) => void }>(({ props }) => ({
  template: html\`<p>\${props.rows().length}</p>\`,
}));
`);
    expect(out).not.toMatch(/\bdefineComponent\s*[<(]/);
    expect(registrationHead(out)).toBe("__registerComponentLean('grid', ");
  });

  test('an explicit selector keeps its place; type arguments and comments before the ( go', () => {
    const out = compile(`import { defineComponent } from 'thane';
export const Tagged = defineComponent /* setup below */ <{ n: number }>('x-tagged', ({ props }) => ({
  template: html\`<p>\${props.n}</p>\`,
}));
`);
    expect(registrationHead(out)).toBe("__registerComponentLean('x-tagged', ");
  });

  test('the binding function is inserted before a stripped first property at the same position', () => {
    const out = compile(`import { defineComponent, signal } from 'thane';
export const Count = defineComponent(() => {
  const n = signal(1);
  return {
    template: html\`<p>\${n()}</p>\`,
    onMount: () => {},
  };
});
`);
    expect(out).toContain('  return {\n  __b: (ctx, _ns) => {\n  const _subs = [];\n');
    expect(out).toMatch(/_subs\[i\]\(\); \};\n {2}\},\n {2}\};\n\}, __tpl\);/);
  });
});
