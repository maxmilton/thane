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
