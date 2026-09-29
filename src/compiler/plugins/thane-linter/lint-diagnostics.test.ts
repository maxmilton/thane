/**
 * Lint rule diagnostics, pinned in full: severity, message, code and location (file, line, column).
 *
 * lint-rules.test.ts pins codes and counts. These tests pin everything else a user sees, plus the
 * shapes each rule accepts or skips: which return objects THANE401/402 inspect, which calls count as
 * defineComponent, which tags count as html/css, and how THANE411 keys mount targets.
 * THANE406 (no-element-id) is retired: compiled code no longer uses ids. THANE407 (single-component-per-file)
 * is retired: each component of a file is compiled on its own. THANE410 (no-cross-file-html-template) is
 * retired: a template can use a fragment another module exports.
 */

import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { ErrorCode } from '../../errors.js';
import type { Diagnostic } from '../../types.js';
import type { LintRuleDefinition } from './rules/types.js';
import {
  noDefaultExportComponent,
  componentPropertyOrder,
  lifecycleArrowFunction,
  requireConstTaggedTemplates,
  noNestedHtmlTags,
  noConditionalTemplateInit,
  componentConstDeclaration,
  noAliasedComponentExport,
  duplicateMountTarget,
  singleReturnObject,
  noAliasedThaneImport,
} from './rules/index.js';

/** The path passed to the rule. The source is parsed as 'parsed.ts', so the reported file must come from here. */
const FILE = 'C:/app/src/widget.ts';

const run = (rule: LintRuleDefinition, src: string[]): Diagnostic[] =>
  rule.check(ts.createSourceFile('parsed.ts', src.join('\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), FILE);

/** A diagnostic at the first occurrence of `needle` on 1-based line `line` of `src`. */
const diag =
  (severity: 'error' | 'warning', code: string) =>
  (src: string[], line: number, needle: string, message: string): Diagnostic => {
    const column = src[line - 1]!.indexOf(needle) + 1;
    if (column === 0) throw new Error(`'${needle}' is not on line ${line}`);
    return { severity, message, location: { file: FILE, line, column }, code };
  };

// ============================================================================
// THANE400: no-default-export-component
// ============================================================================

describe('THANE400 diagnostics', () => {
  const error = diag('error', ErrorCode.NO_DEFAULT_EXPORT_COMPONENT);
  const MESSAGE = 'defineComponent must use a named export: export const MyComponent = defineComponent(...)';

  test('reports at the export statement, after its doc comment', () => {
    const src = [
      "import { defineComponent } from 'thane';",
      '',
      '/** The app. */',
      '  export default defineComponent(() => ({ template: html`<div/>` }));',
    ];
    expect(run(noDefaultExportComponent, src)).toStrictEqual([error(src, 4, 'export default', MESSAGE)]);
  });

  test('ignores a member callee, a parenthesised call and export =', () => {
    expect(run(noDefaultExportComponent, ['export default lib.defineComponent(() => ({}));'])).toStrictEqual([]);
    expect(run(noDefaultExportComponent, ['export default (defineComponent(() => ({})));'])).toStrictEqual([]);
    expect(run(noDefaultExportComponent, ['export = defineComponent(() => ({}));'])).toStrictEqual([]);
  });
});

// ============================================================================
// THANE401: component-property-order
// ============================================================================

describe('THANE401 diagnostics', () => {
  const error = diag('error', ErrorCode.COMPONENT_PROPERTY_ORDER);
  const before = (name: string, last: string) =>
    `'${name}' must be declared before '${last}' (required order: template → styles → onMount → onDestroy)`;

  test('reports each property that goes back in the order, against the previous lifecycle property', () => {
    const src = [
      'export const A = defineComponent(() => ({',
      '  onMount: () => {},',
      '  label: "x",',
      '  template: html`<div/>`,',
      '  onDestroy: () => {},',
      '    styles: css`x`,',
      '}));',
    ];
    expect(run(componentPropertyOrder, src)).toStrictEqual([
      error(src, 4, 'template', before('template', 'onMount')),
      error(src, 6, 'styles', before('styles', 'onDestroy')),
    ]);
  });

  test('counts shorthand and method properties; skips string, computed, spread and accessor properties', () => {
    const src = [
      'export const A = defineComponent(() => {',
      '  return {',
      '    onDestroy() {},',
      '    template,',
      "    'onMount': m,",
      '    [styles]: s,',
      '    ...rest,',
      '    get onMount() { return m; },',
      '    styles: s,',
      '  };',
      '});',
    ];
    expect(run(componentPropertyOrder, src)).toStrictEqual([
      error(src, 4, 'template', before('template', 'onDestroy')),
    ]);
  });

  test('inspects concise bodies in any number of parentheses and top-level returns of block bodies', () => {
    const src = [
      'const A = defineComponent(() => (({ styles: s, template: t })));',
      "const B = defineComponent('x-b', function () {",
      '  const helper = () => ({ onDestroy: d, onMount: m });',
      '  return { styles: s, template: t };',
      '});',
      'const make = () => defineComponent(() => ({ styles: s, template: t }));',
    ];
    expect(run(componentPropertyOrder, src)).toStrictEqual([
      error(src, 1, 'template', before('template', 'styles')),
      error(src, 4, 'template', before('template', 'styles')),
      error(src, 6, 'template', before('template', 'styles')),
    ]);
  });

  test('inspects the setup of a parenthesised arrow only if it is a direct argument', () => {
    // `(() => …)` is a ParenthesizedExpression, not an arrow function: the first line is skipped.
    const src = [
      'const A = defineComponent((() => ({ styles: s, template: t })));',
      'const B = defineComponent(() => ({ styles: s, template: t }));',
    ];
    expect(run(componentPropertyOrder, src)).toStrictEqual([error(src, 2, 'template', before('template', 'styles'))]);
  });

  test('inspects a parenthesised return; skips nested and non-object returns and calls inside another', () => {
    const src = [
      'export const A = defineComponent(() => {',
      '  if (x) {',
      '    return { styles: s, template: t };',
      '  }',
      '  function inner() {',
      '    return { styles: s, template: t };',
      '  }',
      '  const Inner = defineComponent(() => ({ styles: s, template: t }));',
      '  return ({ styles: s, template: t });',
      '});',
      'const B = defineComponent(() => build({ styles: s, template: t }));',
      'const C = lib.defineComponent(() => ({ styles: s, template: t }));',
    ];
    expect(run(componentPropertyOrder, src)).toStrictEqual([error(src, 9, 'template', before('template', 'styles'))]);
  });

  test('inspects every function-like argument and every top-level return', () => {
    const src = [
      'const A = defineComponent(() => ({ onDestroy: d, onMount: m }), function () {',
      '  return { styles: s, template: t };',
      '  return { onMount: m, styles: s };',
      '});',
    ];
    expect(run(componentPropertyOrder, src)).toStrictEqual([
      error(src, 1, 'onMount', before('onMount', 'onDestroy')),
      error(src, 2, 'template', before('template', 'styles')),
      error(src, 3, 'styles', before('styles', 'onMount')),
    ]);
  });
});

// ============================================================================
// THANE402: lifecycle-arrow-function
// ============================================================================

describe('THANE402 diagnostics', () => {
  const error = diag('error', ErrorCode.LIFECYCLE_ARROW_FUNCTION);
  const method = (n: string) => `'${n}' must be an arrow function, not a method shorthand (use '${n}: () => { ... }')`;
  const fnExpr = (n: string) =>
    `'${n}' must be an arrow function, not a function expression (use '${n}: () => { ... }')`;
  const inline = (n: string) => `'${n}' must be an inline arrow function (use '${n}: () => { ... }')`;

  test('reports method shorthand, function expressions and other values; accepts arrows', () => {
    const src = [
      'const A = defineComponent(() => ({',
      '  template: html`<div/>`,',
      '    onMount() {},',
      '  onDestroy: function () {},',
      '}));',
      'const B = defineComponent(() => ({ onMount: handler, onDestroy: make() }));',
      'const C = defineComponent(() => ({ onMount: () => {}, onDestroy: async () => {} }));',
    ];
    expect(run(lifecycleArrowFunction, src)).toStrictEqual([
      error(src, 3, 'onMount', method('onMount')),
      error(src, 4, 'onDestroy', fnExpr('onDestroy')),
      error(src, 6, 'onMount', inline('onMount')),
      error(src, 6, 'onDestroy', inline('onDestroy')),
    ]);
  });

  test('reports shorthand, accessor and string-named hooks; skips other properties', () => {
    const src = [
      'const A = defineComponent(() => ({',
      '  onMount,',
      '  get onDestroy() { return d; },',
      "  'onMount': function () {},",
      '  onClick() {},',
      '}));',
    ];
    expect(run(lifecycleArrowFunction, src)).toStrictEqual([
      error(src, 2, 'onMount', inline('onMount')),
      error(src, 3, 'get', `'onDestroy' must be an arrow function, not an accessor (use 'onDestroy: () => { ... }')`),
      error(src, 4, "'onMount'", fnExpr('onMount')),
    ]);
  });

  test('inspects the same return objects as THANE401', () => {
    const src = [
      'const A = defineComponent((() => (({ onMount() {} }))));',
      "const B = defineComponent('x-b', function () {",
      '  if (x) return { onMount() {} };',
      '  const helper = () => ({ onMount() {} });',
      '  return ({ onDestroy() {} });',
      '  return { onDestroy() {} };',
      '});',
      'const C = defineComponent(() => ({ onMount() {} }), () => ({ onDestroy() {} }));',
      'const D = defineComponent(() => ({ template: t, inner: defineComponent(() => ({ onMount() {} })) }));',
    ];
    expect(run(lifecycleArrowFunction, src)).toStrictEqual([
      error(src, 5, 'onDestroy', method('onDestroy')),
      error(src, 6, 'onDestroy', method('onDestroy')),
      error(src, 8, 'onMount', method('onMount')),
      error(src, 8, 'onDestroy', method('onDestroy')),
    ]);
  });
});

// ============================================================================
// THANE403: require-const-tagged-templates
// ============================================================================

describe('THANE403 diagnostics', () => {
  const error = diag('error', ErrorCode.REQUIRE_CONST_TAGGED_TEMPLATES);
  const message = (tag: string, keyword: string) =>
    `'${tag}\`\`' tagged template must use 'const', not '${keyword}'. ` +
    `Templates declared with '${keyword}' can be reassigned and cannot be resolved at compile time.`;

  test('reports each html or css declarator of a let, var or using statement', () => {
    const src = [
      'let header = html`<h1/>`, count = 1, footer = css`x`;',
      'function f() {',
      '  var inner = html`<p/>`;',
      '}',
      'using res = html`<i/>`;',
      'await using res2 = html`<i/>`;',
      'const ok = html`<b/>`;',
    ];
    expect(run(requireConstTaggedTemplates, src)).toStrictEqual([
      error(src, 1, 'header', message('html', 'let')),
      error(src, 1, 'footer', message('css', 'let')),
      error(src, 3, 'inner', message('html', 'var')),
      error(src, 5, 'res', message('html', 'using')),
    ]);
  });

  test('ignores other tags, member tags, untagged and wrapped templates', () => {
    const src = [
      'let a = sql`x`;',
      'let b = lib.html`<b/>`;',
      'let c = `<c/>`;',
      'let d = (html`<d/>`);',
      'let e = wrap(css`x`);',
      'for (let f = html`<f/>`; ; ) {}',
    ];
    expect(run(requireConstTaggedTemplates, src)).toStrictEqual([]);
  });
});

// ============================================================================
// THANE404: no-nested-html-tags
// ============================================================================

describe('THANE404 diagnostics', () => {
  const error = diag('error', ErrorCode.NO_NESTED_HTML_TAGS);
  const MESSAGE =
    "An 'html' template here is not compiled: inside another template, one is compiled where it is the whole " +
    '${…} or a directive argument. Use whenElse() to choose between templates, and repeat() for a list.';

  test('reports a nested html template at its tag unless it is the whole ${} or in a directive call', () => {
    const src = [
      'const t = html`<div>${html`<p>${html`<i/>`}</p>`}</div>`;',
      'const u = html`${when(x(), html`<b/>`)}${whenElse(x(), html`<c/>`, html`<d/>`)}`;',
      'const v = html`${fmt(html`<e/>`)}`;',
      'const w = html`${repeat(xs, (i) => html`${html`<s/>`}`)}`;',
      'const m = html`${lib.html`<q/>`}${lib.when(x(), html`<r/>`)}`;',
      "const y = html`${on() ? html`<y/>` : ''}${xs.map((i) => html`<z/>`)}`;",
      'const k = html`${fmt(html`${html`<k/>`}`)}`;',
    ];
    expect(run(noNestedHtmlTags, src)).toStrictEqual([
      error(src, 3, 'html`<e/>', MESSAGE),
      error(src, 5, 'html`<r/>', MESSAGE),
      error(src, 6, 'html`<y/>', MESSAGE),
      error(src, 6, 'html`<z/>', MESSAGE),
      error(src, 7, 'html`${html', MESSAGE),
    ]);
  });
});

// ============================================================================
// THANE405: no-conditional-template-init
// ============================================================================

describe('THANE405 diagnostics', () => {
  const warning = diag('warning', ErrorCode.NO_CONDITIONAL_TEMPLATE_INIT);
  const TERNARY =
    'Conditional assignment of tagged templates is not supported. ' +
    "The compiler cannot determine which template to use at compile time. Use 'whenElse()' instead.";
  const LOGICAL =
    'Logical expression assignment of tagged templates is not supported. ' +
    "The compiler cannot resolve the template value at compile time. Use 'whenElse()' instead.";

  test('reports ternaries and logical expressions whose operands contain html or css', () => {
    const src = [
      'const a = on ? html`<a/>` : null;',
      'const b = on ? null : wrap(css`x`);',
      'const c = html`<c/>` ? 1 : 2;',
      'let d = x ?? html`<d/>`;',
      'var e = x || lib.html`<e/>`;',
      'function f() { const g = y && html`<g/>`; }',
      'const h = cond ? sql`x` : [html`<h/>`];',
      'const i = a + html`<i/>`;',
      'const j = (on ? html`<j/>` : null);',
    ];
    expect(run(noConditionalTemplateInit, src)).toStrictEqual([
      warning(src, 1, 'a =', TERNARY),
      warning(src, 2, 'b =', TERNARY),
      warning(src, 4, 'd =', LOGICAL),
      warning(src, 6, 'g =', LOGICAL),
      warning(src, 7, 'h =', TERNARY),
    ]);
  });
});

// ============================================================================
// THANE408: component-const-declaration
// ============================================================================

describe('THANE408 diagnostics', () => {
  const error = diag('error', ErrorCode.COMPONENT_CONST_DECLARATION);
  const message = (keyword: string) =>
    `Component declaration must use 'const', not '${keyword}'. ` +
    "Reassigning a component variable breaks the compiler's static analysis " +
    'and can cause selector collisions.';

  test('reports each defineComponent declarator of a let, var or using statement', () => {
    const src = [
      'export let A = defineComponent(() => ({ template: html`<a/>` })), n = 1;',
      'function f() {',
      '  var B = defineComponent(() => ({}));',
      '}',
      'using C = defineComponent(() => ({}));',
      'await using C2 = defineComponent(() => ({}));',
      'const D = defineComponent(() => ({}));',
      'let E = lib.defineComponent(() => ({}));',
      'let F = (defineComponent(() => ({})));',
    ];
    expect(run(componentConstDeclaration, src)).toStrictEqual([
      error(src, 1, 'A =', message('let')),
      error(src, 3, 'B =', message('var')),
      error(src, 5, 'C =', message('using')),
    ]);
  });
});

// ============================================================================
// THANE409: no-aliased-component-export
// ============================================================================

describe('THANE409 diagnostics', () => {
  const error = diag('error', ErrorCode.NO_ALIASED_COMPONENT_EXPORT);
  const reExport = (name: string) =>
    `Component re-exports are not supported. Define the component in this file instead: ` +
    `export const ${name} = defineComponent(...)`;
  const aliased = (local: string, exported: string) =>
    `Aliased component export is not supported: '${local}' exported as '${exported}'. ` +
    'The compiler derives the selector from the declaration name, not the exported name. ' +
    `Use 'export const ${exported} = defineComponent(...)' instead.`;
  const deferred = (name: string) =>
    `Deferred component export is not supported. The compiler requires the export keyword ` +
    `on the declaration: export const ${name} = defineComponent(...)`;

  test('reports aliased and deferred exports of local components, and PascalCase re-exports', () => {
    const src = [
      'const Inner = defineComponent(() => ({ template: html`<a/>` }));',
      'const Plain = defineComponent(() => ({ template: html`<b/>` }));',
      'function f() { const Deep = defineComponent(() => ({})); }',
      'const Lib = lib.defineComponent(() => ({}));',
      'const Wrapped = (defineComponent(() => ({})));',
      'const helper = 1;',
      'export { Inner as Outer, Plain, helper as Helper, Deep, Lib as Lib2, Wrapped as W };',
      "export { Card, util, type Model } from './card.js';",
      "export {   x as Button } from './button.js';",
      "export type { Shape } from './shape.js';",
    ];
    expect(run(noAliasedComponentExport, src)).toStrictEqual([
      error(src, 7, 'Inner as', aliased('Inner', 'Outer')),
      error(src, 7, 'Plain', deferred('Plain')),
      error(src, 7, 'Deep', deferred('Deep')),
      error(src, 8, 'Card', reExport('Card')),
      error(src, 9, 'x as', reExport('Button')),
    ]);
  });
});

// ============================================================================
// THANE411: duplicate-mount-target
// ============================================================================

describe('THANE411 diagnostics', () => {
  const warning = diag('warning', ErrorCode.DUPLICATE_MOUNT_TARGET);
  const message = (target: string, previousLine: number) =>
    `Duplicate mount() call targeting ${target}. ` +
    `A previous mount() to the same target was found at line ${previousLine}. ` +
    'Mounting multiple components to the same target appends duplicate content ' +
    'and causes binding collisions. Use a different target element for each mount().';
  const BODY = 'document.body';

  test('keys every way of writing a target, and names the first mount of each target', () => {
    const src = [
      'mount(App);',
      '  mount(Other);',
      'mount({ component: App });',
      'mount({ component: App, target });',
      "mount({ 'target': el });",
      'mount(...args);',
      'mount(options);',
      'mount({ component: B, target: el });',
      "mount({ target: document.getElementById('app') });",
      'mount({ target: document.body });',
      "mount({ target: document.getElementById('app') });",
      'mount({ target: els[0] });',
      'mount({ target: els[0] });',
      'mount({ target: (el as HTMLElement)! });',
      'mount({ target: target });',
      'lib.mount(App);',
      'mount({ target: document.body, component: C }, extra);',
    ];
    // The old mount(App) form, a spread and an options variable are not compared: their target is
    // unknown. The shorthand `{ target }` and a string key are the variables they name.
    expect(run(duplicateMountTarget, src)).toStrictEqual([
      warning(src, 8, 'mount', message('var:el', 5)),
      warning(src, 10, 'mount', message(BODY, 3)),
      warning(src, 11, 'mount', message("document.getElementById('app')", 9)),
      warning(src, 13, 'mount', message('els[0]', 12)),
      warning(src, 14, 'mount', message('var:el', 5)),
      warning(src, 15, 'mount', message('var:target', 4)),
      warning(src, 17, 'mount', message(BODY, 3)),
    ]);
  });

  test('tracks each function scope on its own', () => {
    const src = [
      'mount({ component: App, target: el });',
      'const f = () => {',
      '  mount({ component: App, target: el });',
      '  const g = function () { mount({ component: App, target: el }); };',
      '  mount({ component: Other, target: el });',
      '};',
      'mount({ component: Other, target: el });',
    ];
    expect(run(duplicateMountTarget, src)).toStrictEqual([
      warning(src, 5, 'mount', message('var:el', 3)),
      warning(src, 7, 'mount', message('var:el', 1)),
    ]);
  });
});

// ============================================================================
// THANE412: single-return-object
// ============================================================================

describe('THANE412 diagnostics', () => {
  const error = diag('error', ErrorCode.SINGLE_RETURN_OBJECT);
  const MESSAGE =
    'A setup function with more than one return object is not supported. ' +
    "The compiler builds one template per component, from the last return, so this one is never used. Use 'when()' or 'whenElse()' in the template instead.";

  test('reports every return object but the last, at any depth, at its return', () => {
    const src = [
      'export const App = defineComponent(() => {',
      '  if (flag) {',
      '    return { template: html`<p>a</p>` };',
      '  }',
      '  for (const x of xs) { if (x) return { template: html`<p>b</p>` }; }',
      '  return { template: html`<p>c</p>` };',
      '});',
    ];
    expect(run(singleReturnObject, src)).toStrictEqual([
      error(src, 3, 'return', MESSAGE),
      error(src, 5, 'return', MESSAGE),
    ]);
  });

  test('the setup after a selector counts; each component on its own', () => {
    const src = [
      "export const A = defineComponent('x-a', function () {",
      '  if (flag) return { template: html`<p>a</p>` };',
      '  return { template: html`<p>b</p>` };',
      '});',
      'export const B = defineComponent(() => ({ template: html`<p>b</p>` }));',
    ];
    expect(run(singleReturnObject, src)).toStrictEqual([error(src, 2, 'return', MESSAGE)]);
  });

  test('accepts one return object, a concise body, returns inside nested functions, and other returns', () => {
    const src = [
      'export const A = defineComponent(() => {',
      '  const helper = () => { return { a: 1 }; };',
      '  function decl() { return { b: 2 }; }',
      '  const obj = { method() { return { c: 3 }; } };',
      '  if (flag) return;',
      '  return { template: html`<p>a</p>` };',
      '});',
      'export const B = defineComponent(() => (({ template: html`<p>b</p>` })));',
      'const notAComponent = () => { if (flag) return { a: 1 }; return { b: 2 }; };',
    ];
    expect(run(singleReturnObject, src)).toStrictEqual([]);
  });
});

// ============================================================================
// THANE413: no-aliased-thane-import
// ============================================================================

describe('THANE413 diagnostics', () => {
  const error = diag('error', ErrorCode.NO_ALIASED_THANE_IMPORT);

  test('reports a marker or defineComponent imported under another name, at the specifier', () => {
    const src = [
      "import { html as h, repeat, defineComponent as dc, signal as s } from 'thane';",
      "import { css as style } from 'thane';",
    ];
    expect(run(noAliasedThaneImport, src)).toStrictEqual([
      error(
        src,
        1,
        'html as h',
        "'html' is imported as 'h', and the compiler finds it only by its own name. Import it as 'html': import { html } from 'thane'",
      ),
      error(
        src,
        1,
        'defineComponent as dc',
        "'defineComponent' is imported as 'dc', and the compiler finds it only by its own name. " +
          "Import it as 'defineComponent': import { defineComponent } from 'thane'",
      ),
      error(
        src,
        2,
        'css as style',
        "'css' is imported as 'style', and the compiler finds it only by its own name. Import it as 'css': import { css } from 'thane'",
      ),
    ]);
  });

  test("reports a marker read through a namespace import of 'thane'", () => {
    const src = [
      "import * as thane from 'thane';",
      'export const App = thane.defineComponent(() => ({',
      '  template: thane.html`<ul>${thane.repeat(items(), row)}</ul>`,',
      '}));',
      'const count = thane.signal(0);',
    ];
    const message = (text: string, name: string) =>
      `'${text}' is not compiled: the compiler finds '${name}' only by its own name. Import it by name: import { ${name} } from 'thane'`;
    expect(run(noAliasedThaneImport, src)).toStrictEqual([
      error(src, 2, 'thane.defineComponent', message('thane.defineComponent', 'defineComponent')),
      error(src, 3, 'thane.html', message('thane.html', 'html')),
      error(src, 3, 'thane.repeat', message('thane.repeat', 'repeat')),
    ]);
  });

  test('accepts the markers under their own names, other aliases, type imports and other modules', () => {
    const src = [
      "import { defineComponent, html, css, when, whenElse, repeat, signal as s } from 'thane';",
      "import { type Signal as S } from 'thane';",
      "import type { MountHandle as H } from 'thane';",
      "import { html as litHtml } from 'lit';",
      "import * as other from 'other';",
      'other.html`<p></p>`;',
    ];
    expect(run(noAliasedThaneImport, src)).toStrictEqual([]);
  });
});
