/**
 * Lint rule diagnostics, pinned in full: severity, message, code and location (file, line, column).
 *
 * lint-rules.test.ts pins codes and counts. These tests pin everything else a user sees, plus the
 * shapes each rule accepts or skips: which return objects THANE401/402 inspect, which calls count as
 * defineComponent, which tags count as html/css, and how THANE411 keys mount targets.
 * THANE406 (no-element-id) is not covered here: A1-5 deletes that rule.
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
  singleComponentPerFile,
  componentConstDeclaration,
  noAliasedComponentExport,
  noCrossFileHtmlTemplate,
  duplicateMountTarget,
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

  test('skips parenthesised, nested and non-object returns, and defineComponent calls inside another', () => {
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
    expect(run(componentPropertyOrder, src)).toStrictEqual([]);
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

  test('skips shorthand, accessor, string-named and other properties', () => {
    const src = [
      'const A = defineComponent(() => ({',
      '  onMount,',
      '  get onDestroy() { return d; },',
      "  'onMount': function () {},",
      '  onClick() {},',
      '}));',
    ];
    expect(run(lifecycleArrowFunction, src)).toStrictEqual([]);
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
      // A `using` declaration is reported as 'var' today (its flags are neither Let nor Const).
      error(src, 5, 'res', message('html', 'var')),
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
    "Nested 'html' tagged templates are not supported. The inner template will not be " +
    'processed for signal bindings or subscriptions. Extract it into a const variable instead.';

  test('reports every nested html template at its tag; directive calls reset the nesting', () => {
    const src = [
      'const t = html`<div>${html`<p>${html`<i/>`}</p>`}</div>`;',
      'const u = html`${when(x(), html`<b/>`)}${whenElse(x(), html`<c/>`, html`<d/>`)}`;',
      'const v = html`${fmt(html`<e/>`)}`;',
      'const w = html`${repeat(xs, (i) => html`${html`<s/>`}`)}`;',
      'const m = html`${lib.html`<q/>`}${lib.when(x(), html`<r/>`)}`;',
    ];
    expect(run(noNestedHtmlTags, src)).toStrictEqual([
      error(src, 1, 'html`<p>', MESSAGE),
      error(src, 1, 'html`<i/>', MESSAGE),
      error(src, 3, 'html`<e/>', MESSAGE),
      error(src, 4, 'html`<s/>', MESSAGE),
      error(src, 5, 'html`<r/>', MESSAGE),
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
// THANE407: single-component-per-file
// ============================================================================

describe('THANE407 diagnostics', () => {
  const error = diag('error', ErrorCode.SINGLE_COMPONENT_PER_FILE);
  const message = (n: number) =>
    `Only one defineComponent() is allowed per file. Found ${n} calls — ` +
    'the compiler processes only one component per file. Split additional components into separate files.';

  test('reports every declaration or default export after the first, with the total count', () => {
    const src = [
      'export const A = defineComponent(() => ({ template: html`<a/>` }));',
      'function make() {',
      '  let B = defineComponent(() => ({})), C = defineComponent(() => ({}));',
      '}',
      '/** Doc. */',
      'export default defineComponent(() => ({ template: html`<c/>` }));',
      'const notOne = lib.defineComponent(() => ({}));',
      'const alsoNot = (defineComponent(() => ({})));',
      'defineComponent(() => ({}));',
    ];
    expect(run(singleComponentPerFile, src)).toStrictEqual([
      error(src, 3, 'B =', message(4)),
      error(src, 3, 'C =', message(4)),
      error(src, 6, 'export default', message(4)),
    ]);
  });

  test('counts a defineComponent declared inside a setup function', () => {
    const src = ['export const A = defineComponent(() => {', '  const Inner = defineComponent(() => ({}));', '});'];
    expect(run(singleComponentPerFile, src)).toStrictEqual([error(src, 2, 'Inner', message(2))]);
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
      // A `using` declaration is reported as 'var' today (its flags are neither Let nor Const).
      error(src, 5, 'C =', message('var')),
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
// THANE410: no-cross-file-html-template
// ============================================================================

describe('THANE410 diagnostics', () => {
  const warning = diag('warning', ErrorCode.NO_CROSS_FILE_HTML_TEMPLATE);
  const message = (name: string) =>
    `Imported variable '${name}' is used inside an html\`\` template. ` +
    'The compiler cannot resolve imported template variables at compile time. ' +
    'Define the template fragment in the same file as a const variable instead.';

  test('reports bare imported identifiers in html interpolations, at the identifier', () => {
    const src = [
      "import Header from './header.js';",
      "import { footer as Footer, nav } from './parts.js';",
      "import * as parts from './parts.js';",
      "import './side-effect.js';",
      'const local = html`<i/>`;',
      'export const A = defineComponent(() => ({',
      '  template: html`${Header}<main>${local}${ Footer }${nav()}${parts.x}${parts}</main>`,',
      '}));',
      'const t = lib.html`${Header}`;',
      'const u = css`${Header}`;',
      'const v = html`<p>${nav}</p>`;',
    ];
    expect(run(noCrossFileHtmlTemplate, src)).toStrictEqual([
      warning(src, 7, 'Header', message('Header')),
      warning(src, 7, 'Footer', message('Footer')),
      warning(src, 7, 'parts}', message('parts')),
      warning(src, 11, 'nav', message('nav')),
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
  const BODY = 'document.body (default)';

  test('keys both call shapes the same way and names the first mount of each target', () => {
    const src = [
      'mount(App);',
      '  mount(Other);',
      'mount({ component: App });',
      'mount({ component: App, target });',
      "mount({ 'target': el });",
      'mount(...args);',
      'mount(App, el);',
      'mount({ component: B, target: el });',
      'mount(App, document.body);',
      'mount({ target: document.body });',
      "mount(App, document.getElementById('app'));",
      "mount({ target: document.getElementById('app') });",
      'mount(App, els[0]);',
      'mount({ target: els[0] });',
      'mount(App, el!);',
      'mount({ target: el! });',
      'mount(App, (el));',
      'lib.mount(App);',
      'mount({ target: document.body, component: C }, extra);',
    ];
    expect(run(duplicateMountTarget, src)).toStrictEqual([
      warning(src, 2, 'mount', message(BODY, 1)),
      warning(src, 3, 'mount', message(BODY, 1)),
      warning(src, 4, 'mount', message(BODY, 1)),
      warning(src, 5, 'mount', message(BODY, 1)),
      warning(src, 6, 'mount', message(BODY, 1)),
      warning(src, 8, 'mount', message('var:el', 7)),
      warning(src, 10, 'mount', message('document.body', 9)),
      warning(src, 12, 'mount', message("document.getElementById('app')", 11)),
      warning(src, 14, 'mount', message('els[0]', 13)),
      warning(src, 16, 'mount', message('el!', 15)),
      warning(src, 19, 'mount', message('document.body', 9)),
    ]);
  });

  test('tracks each function scope on its own', () => {
    const src = [
      'mount(App, el);',
      'const f = () => {',
      '  mount(App, el);',
      '  const g = function () { mount(App, el); };',
      '  mount(Other, el);',
      '};',
      'mount(Other, el);',
    ];
    expect(run(duplicateMountTarget, src)).toStrictEqual([
      warning(src, 5, 'mount', message('var:el', 3)),
      warning(src, 7, 'mount', message('var:el', 1)),
    ]);
  });
});
