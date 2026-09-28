/**
 * Characterisation of string skipping in runtime style scoping (before RT-9).
 *
 * RT-9 replaces the two copies of the quote state machine in `splitSelectorList` and
 * `findMatchingBrace` with one `skipString`. scope-css.test.ts (F0-2 item 1) pins scoping as a
 * whole; these rows add the string shapes the shared scanner must treat exactly as today: one
 * quote kind inside the other, empty and adjacent strings, brackets and parentheses inside strings
 * in a selector list, an unterminated string in a selector list, the backslash rule in a selector
 * list, and strings inside a grouping at-rule's body.
 */
import { describe, expect, test } from 'bun:test';
import { scopeCssRules } from './component.js';

const scope = (css: string): string => scopeCssRules(css, '.sel');

const table = (cases: Array<[input: string, expected: string]>) => {
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => {
      expect(scope(input)).toBe(expected);
    });
  }
};

describe('scopeCssRules: strings inside rule bodies', () => {
  table([
    // One quote kind inside the other does not end the string
    [`.a::before { content: "it's" } .b { c: d }`, `.sel .a::before{ content: "it's" }.sel .b{ c: d }`],
    [`.a::before { content: 'say "hi" {' } .b { c: d }`, `.sel .a::before{ content: 'say "hi" {' }.sel .b{ c: d }`],
    // Empty strings, adjacent strings, and a string right after the opening brace
    ['.a::before { content: ""; } .b { c: d }', '.sel .a::before{ content: ""; }.sel .b{ c: d }'],
    [".a::before { content: ''; } .b { c: d }", ".sel .a::before{ content: ''; }.sel .b{ c: d }"],
    ['.a::before { content: "a""}"; } .b { c: d }', '.sel .a::before{ content: "a""}"; }.sel .b{ c: d }'],
    ['.a{content:"}"}.b{c:d}', '.sel .a{content:"}"}.sel .b{c:d}'],
    // An escaped quote followed by a brace stays inside the string
    ['.a { b: "x\\"}" } .c { d: e }', '.sel .a{ b: "x\\"}" }.sel .c{ d: e }'],
  ]);
});

describe('scopeCssRules: strings inside selector lists', () => {
  table([
    // Brackets and parentheses inside a string do not change the nesting depth
    ['[a="("], .b { c: d }', '.sel [a="("], .sel .b{ c: d }'],
    ["[a='['], .b { c: d }", ".sel [a='['], .sel .b{ c: d }"],
    ['[a=")"], .b { c: d }', '.sel [a=")"], .sel .b{ c: d }'],
    [':is([a="x,y"], .b), .c { d: e }', '.sel :is([a="x,y"], .b), .sel .c{ d: e }'],
    // An unterminated string runs to the end of the prelude: no split
    ['[a="x, .b { c: d }', '.sel [a="x, .b{ c: d }'],
    // A quote after a backslash never closes, even an escaped backslash: no split
    ['.a[title="\\\\"], .b { c: d }', '.sel .a[title="\\\\"], .b{ c: d }'],
  ]);
});

describe('scopeCssRules: strings inside grouping at-rules', () => {
  table([
    [
      '@media print { .a::before { content: "}" } .b { c: d } }',
      '@media print {.sel .a::before{ content: "}" }.sel .b{ c: d } }',
    ],
    [
      "@media print { .a::before { content: '{' } } .b { c: d }",
      "@media print {.sel .a::before{ content: '{' } }.sel .b{ c: d }",
    ],
  ]);
});
