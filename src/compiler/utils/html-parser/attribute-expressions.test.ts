/**
 * An expression in an attribute value is one unit up to its closing brace, whatever quotes it holds:
 * a double quote inside `${…}` in a double-quoted value, or anywhere in an unquoted one, does not end
 * the value.
 */
import { describe, expect, test } from 'bun:test';
import { parseHtmlTemplate } from './index.js';

const attributesOf = (html: string): Record<string, string> =>
  Object.fromEntries([...parseHtmlTemplate(html).roots[0]!.attributes].map(([name, attr]) => [name, attr.value]));

describe('attribute values with expressions', () => {
  test('a double-quoted value whose expression holds double quotes', () => {
    expect(attributesOf('<li data-x="${a + "!"}" title="t">x</li>')).toEqual({
      'data-x': '${a + "!"}',
      'title': 't',
    });
  });

  test('a quoted value with text around an expression that holds the quote character', () => {
    expect(attributesOf(`<li class='row \${on() ? 'a' : 'b'} end'>x</li>`)).toEqual({
      class: "row ${on() ? 'a' : 'b'} end",
    });
  });

  test('an unquoted value that starts with text and holds an expression', () => {
    expect(attributesOf('<li class=row-${on() ? "a" : "b"} id=x>x</li>')).toEqual({
      class: 'row-${on() ? "a" : "b"}',
      id: 'x',
    });
  });

  test('an expression value, as before', () => {
    expect(attributesOf('<li class=${sel() === it.id ? "on" : ""}>x</li>')).toEqual({
      class: '${sel() === it.id ? "on" : ""}',
    });
  });

  test('an escaped ${ in a value is text', () => {
    expect(attributesOf('<li title="\\${x}">x</li>')).toEqual({ title: '\\${x}' });
  });
});

describe('a missing space after the tag name', () => {
  test('<button@click=…>: reported, and the attribute is read', () => {
    const parsed = parseHtmlTemplate('<button@click=${go}>x</button>');
    const button = parsed.roots[0]!;
    expect(button.tagName).toBe('button');
    expect([...button.attributes.keys()]).toEqual(['@click']);
    expect(parsed.diagnostics.map((d) => [d.severity, d.message])).toEqual([
      [
        'error',
        'Missing space after <button: "@" cannot be part of a tag name, and is read as the start of an attribute',
      ],
    ]);
  });

  test('<div${when(…)}>: the directive is read', () => {
    const parsed = parseHtmlTemplate('<div${when(on())}>x</div>');
    expect(parsed.roots[0]!.tagName).toBe('div');
    expect(parsed.roots[0]!.whenDirective).toBe('${when(on())}');
    expect(parsed.diagnostics).toHaveLength(1);
  });
});
