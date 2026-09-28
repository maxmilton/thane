/**
 * The runtime `html` and `css` shims exported from `thane` (for unit tests and uncompiled code).
 * Pins the escaping of interpolated values, including the empty string (RT-13).
 */
import { describe, expect, test } from 'bun:test';
import { css, html } from './index.js';

// Aliases, so that Prettier does not format the literals as embedded HTML / CSS
const h = html;
const c = css;

describe('html shim', () => {
  test('static text is returned as written', () => {
    expect(h`<p class="a">x & y</p>`).toBe('<p class="a">x & y</p>');
    expect(h``).toBe('');
  });

  test('interpolated values are stringified and escaped', () => {
    expect(h`<p>${''}</p>`).toBe('<p></p>');
    expect(h`${''}${''}`).toBe('');
    expect(h`<p>${'plain'}</p>`).toBe('<p>plain</p>');
    expect(h`<p>${`&<>"'`}</p>`).toBe('<p>&amp;&lt;&gt;&quot;&#39;</p>');
    expect(h`<p>${'a&amp;b'}</p>`).toBe('<p>a&amp;amp;b</p>');
    expect(h`${0}|${1.5}|${false}|${null}|${undefined}`).toBe('0|1.5|false|null|undefined');
    expect(h`${{ toString: () => '<x>' }}`).toBe('&lt;x&gt;');
  });
});

describe('css shim', () => {
  test('plain concatenation of the cooked strings, without escaping', () => {
    expect(c`.a { content: "${'<&>'}"; }`).toBe('.a { content: "<&>"; }');
    expect(c`.a::before { content: "\\2014"; }`).toBe('.a::before { content: "\\2014"; }');
    expect(c``).toBe('');
  });
});
