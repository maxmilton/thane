/**
 * HTML Parser — Utility functions for working with parsed HTML
 */

import type { HtmlElement } from './types.js';

export function walkElements(roots: HtmlElement[], callback: (element: HtmlElement, depth: number) => void): void {
  const walk = (elements: HtmlElement[], depth: number) => {
    for (const el of elements) {
      callback(el, depth);
      walk(el.children, depth + 1);
    }
  };
  walk(roots, 0);
}

function findElements(roots: HtmlElement[], predicate: (el: HtmlElement) => boolean): HtmlElement[] {
  const results: HtmlElement[] = [];
  walkElements(roots, (el) => {
    if (predicate(el)) {
      results.push(el);
    }
  });
  return results;
}

export function findElementsWithWhenDirective(roots: HtmlElement[]): HtmlElement[] {
  return findElements(roots, (el) => el.whenDirective !== undefined);
}

export function getElementHtml(element: HtmlElement, html: string): string {
  return html.substring(element.tagStart, element.closeTagEnd);
}

/** Whether the element sits inside an `<svg>` subtree (including the `<svg>` element itself). */
function isInsideSvg(element: HtmlElement | null): boolean {
  for (let el = element; el; el = el.parent) {
    if (el.tagName.toLowerCase() === 'svg') return true;
  }
  return false;
}

/**
 * Attributes that a dynamic binding writes as a DOM property on HTML elements. For the boolean
 * ones (`checked`, `disabled`, …) an attribute write would mean "present" whatever the value;
 * for `value` the attribute is only the default, not what the field shows. The static
 * template ships none of these attributes for a bound element (see stripPropertyBoundAttributes).
 * `class` goes through `className` because it is the cheaper write.
 */
const HTML_ATTRIBUTE_PROPERTIES: Record<string, string> = {
  class: 'className',
  style: 'style.cssText',
  value: 'value',
  checked: 'checked',
  selected: 'selected',
  disabled: 'disabled',
  open: 'open',
  hidden: 'hidden',
  readonly: 'readOnly',
  required: 'required',
  multiple: 'multiple',
  indeterminate: 'indeterminate',
  muted: 'muted',
};

/**
 * The DOM property a dynamic attribute is written through instead of `setAttribute`, or
 * undefined for a plain attribute. SVG elements keep `setAttribute` for everything (their
 * `className` is a read-only SVGAnimatedString, and the table is about HTML form semantics).
 */
export function attributeDomProperty(attrName: string, element: HtmlElement | null): string | undefined {
  if (isInsideSvg(element)) return undefined;
  return HTML_ATTRIBUTE_PROPERTIES[attrName.toLowerCase()];
}

/**
 * An escape sequence that is valid in an untagged template literal, or a lone backslash: a tagged
 * template may also hold invalid ones (`\u` without hex digits, `\x1`, `\08`, `\9`).
 */
const _templateEscapeRe = /\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]+\}|0(?![0-9])|[^xu0-9])|\\|`|\$\{/g;

/**
 * The one escaper for every template the compiler emits into a JS template literal (H-02).
 * Templates are carried as written in the source (raw), so the escape sequences the developer
 * wrote (`\\`, `` \` ``, `\${`, `\n`, …) are kept as they are; a backtick or `${` that is not
 * escaped (text the compiler put there) is escaped, so the literal can neither end early nor
 * interpolate. An escape that only a tagged template allows (`` html`C:\users` ``) gets its
 * backslash doubled, so it is shown as written instead of failing the build.
 */
export function escapeTemplateLiteral(s: string): string {
  return s.replace(_templateEscapeRe, (m) => (m === '\\' ? '\\\\' : m[0] === '\\' ? m : '\\' + m));
}

/**
 * A plain string (a signal's initial value) as raw template text: backslashes, backticks and `${`
 * escaped, so that it reads back as itself once the template is emitted.
 */
export function escapeRawTemplateLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}
