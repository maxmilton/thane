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

export function findElements(roots: HtmlElement[], predicate: (el: HtmlElement) => boolean): HtmlElement[] {
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
export function isInsideSvg(element: HtmlElement | null): boolean {
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
 * Escape a string so it can be safely embedded inside a JS template literal.
 * Prevents backticks from breaking the literal and `${` from being
 * interpreted as a template expression.
 *
 * Use this for raw HTML / plain-text content that should appear verbatim
 * inside a template literal.
 */
export function escapeTemplateLiteral(s: string): string {
  return s.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Like {@link escapeTemplateLiteral} but also escapes backslashes.
 * Use when the source string may contain raw backslash sequences
 * (e.g., repeat item templates that originate from raw HTML source).
 */
export function escapeRawTemplateLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

export function injectIdIntoFirstElement(html: string, id: string): string {
  const trimmed = html.trim();
  const firstTagMatch = trimmed.match(/^<(\w+)([^>]*)>/);
  if (!firstTagMatch) {
    return trimmed;
  }

  const tagName = firstTagMatch[1];
  if (!tagName) return trimmed;
  const existingAttrs = firstTagMatch[2] || '';
  if (/\sid\s*=\s*['"][^'"]*['"]/.test(existingAttrs)) {
    return trimmed;
  }
  const tagNameEnd = tagName.length + 1;

  return trimmed.substring(0, tagNameEnd) + ` id="${id}"` + trimmed.substring(tagNameEnd);
}

/** The `id` attribute of a template's first element, if it has one. */
export function firstElementId(html: string): string | undefined {
  const firstTagMatch = html.trim().match(/^<(\w+)([^>]*)>/);
  return firstTagMatch?.[2]?.match(/\sid\s*=\s*['"]([^'"]*)['"]/)?.[1];
}
