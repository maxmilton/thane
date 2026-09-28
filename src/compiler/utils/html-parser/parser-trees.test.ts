/**
 * Characterisation of the HTML template parser (F0-2 item 8, before HP-1 and HP-2).
 *
 * Each case pins the whole parse result of `parseHtmlTemplate`: the element tree with every
 * recorded position, attributes, `when()` directives and text nodes, then the bindings in the
 * order they are reported, then the diagnostics. The expected lines were captured from the parser
 * on e4a17f1; a line that looks wrong is still today's behaviour (see the hand-off note).
 */
import { describe, expect, test } from 'bun:test';
import { parseHtmlTemplate } from './index.js';
import type { BindingDetectionOptions, HtmlElement, ParsedTemplate } from './index.js';

/** One line per element (indented by depth), attribute, directive, text node, binding and diagnostic. */
const describeTree = (parsed: ParsedTemplate): string[] => {
  const lines: string[] = [];
  const element = (e: HtmlElement, depth: number) => {
    const pad = '  '.repeat(depth);
    const flags = [e.isVoid ? 'void' : '', e.isSelfClosing ? 'self-closing' : ''].filter(Boolean).join(' ');
    lines.push(
      `${pad}<${e.tagName}> tag ${e.tagStart}-${e.tagNameEnd} open-end ${e.openTagEnd} close ${e.closeTagStart}-${e.closeTagEnd}${flags ? ' ' + flags : ''}`,
    );
    if (e.whenDirective !== undefined) {
      lines.push(`${pad}  when ${JSON.stringify(e.whenDirective)} ${e.whenDirectiveStart}-${e.whenDirectiveEnd}`);
    }
    for (const [name, a] of e.attributes) {
      lines.push(
        `${pad}  attr ${name}=${JSON.stringify(a.value)} ${a.start}-${a.end} value ${a.valueStart}-${a.valueEnd}`,
      );
    }
    for (const t of e.textContent) lines.push(`${pad}  text ${JSON.stringify(t.content)} ${t.start}-${t.end}`);
    for (const c of e.children) {
      if (c.parent !== e) lines.push(`${pad}  (parent link broken)`);
      element(c, depth + 1);
    }
  };
  for (const root of parsed.roots) element(root, 0);
  for (const b of parsed.bindings) {
    const { element: owner, type, ...rest } = b;
    const fields = Object.entries(rest)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    lines.push(`binding ${type} on <${owner.tagName}@${owner.tagStart}> ${fields}`);
  }
  for (const d of parsed.diagnostics) lines.push(`${d.severity} @${d.position}: ${d.message}`);
  return lines;
};

const tree = (name: string, html: string, expected: string[], options?: BindingDetectionOptions) => {
  test(name, () => {
    const parsed = parseHtmlTemplate(html, options);
    expect(parsed.html).toBe(html);
    expect(describeTree(parsed)).toEqual(expected);
  });
};

describe('attributes', () => {
  tree(
    'unquoted values, a bare attribute, and a value with a slash',
    '<input type=text value=abc disabled><a href=/x>go</a>',
    [
      '<input> tag 0-6 open-end 36 close 36-36 void',
      '  attr type="text" 7-16 value 12-16',
      '  attr value="abc" 17-26 value 23-26',
      '  attr disabled="" 27-35 value 35-35',
      '<a> tag 36-38 open-end 47 close 49-53',
      '  attr href="/x" 39-46 value 44-46',
      '  text "go" 47-49',
    ],
  );
  tree('whitespace around = and between attributes', '<div  a = "1"   b\n=\'2\'  c ></div>', [
    '<div> tag 0-4 open-end 27 close 27-33',
    '  attr a="1" 6-13 value 11-12',
    '  attr b="2" 16-22 value 20-21',
    '  attr c="" 24-25 value 25-25',
  ]);
  tree(
    '${} values: bare signal, text around an expression, a non-signal call, an event handler',
    '<div class=${cls()} title="a ${t()} b" data-x=${fn({ a: 1 })} @click=${() => go(1)}></div>',
    [
      '<div> tag 0-4 open-end 84 close 84-90',
      '  attr class="${cls()}" 5-19 value 11-19',
      '  attr title="a ${t()} b" 20-38 value 27-37',
      '  attr data-x="${fn({ a: 1 })}" 39-61 value 46-61',
      '  attr @click="${() => go(1)}" 62-83 value 69-83',
      'binding attr on <div@0> signalName="cls" property="class" expressionStart=11 expressionEnd=19 fullExpression="${cls()}"',
      'binding attr on <div@0> signalName="t" signalNames=["t"] jsExpression="`a ${t()} b`" property="title" expressionStart=27 expressionEnd=37 fullExpression="a ${t()} b"',
      'binding event on <div@0> signalName="" eventName="click" eventModifiers=[] handlerExpression="() => go(1)" expressionStart=62 expressionEnd=83 fullExpression="@click=\\"${() => go(1)}\\""',
    ],
  );
  tree(
    'style declarations and a whole-value style expression',
    '<p style="color: ${c()}; width: ${w()}px; margin: 0">s</p><p style=${css()}>t</p>',
    [
      '<p> tag 0-2 open-end 53 close 54-58',
      '  attr style="color: ${c()}; width: ${w()}px; margin: 0" 3-52 value 10-51',
      '  text "s" 53-54',
      '<p> tag 58-60 open-end 76 close 77-81',
      '  attr style="${css()}" 61-75 value 67-75',
      '  text "t" 76-77',
      'binding style on <p@0> signalName="c" property="color" expressionStart=17 expressionEnd=23 fullExpression="${c()}"',
      'binding style on <p@0> signalName="w" signalNames=["w"] jsExpression="`${w()}px`" property="width" expressionStart=32 expressionEnd=40 fullExpression="${w()}px"',
      'binding attr on <p@58> signalName="css" property="style" expressionStart=67 expressionEnd=75 fullExpression="${css()}"',
    ],
  );
  tree(
    'non-signal expressions with detectNonSignalBindings',
    '<p title=${product.title} style="width: ${size}px">${product.name}</p>',
    [
      '<p> tag 0-2 open-end 51 close 66-70',
      '  attr title="${product.title}" 3-25 value 9-25',
      '  attr style="width: ${size}px" 26-50 value 33-49',
      '  text "${product.name}" 51-66',
      'binding attr on <p@0> signalName="" signalNames=[] jsExpression="product.title" property="title" expressionStart=9 expressionEnd=25 fullExpression="${product.title}"',
      'binding style on <p@0> signalName="" signalNames=[] jsExpression="`${size}px`" property="width" expressionStart=40 expressionEnd=49 fullExpression="${size}px"',
      'binding text on <p@0> signalName="" signalNames=[] expressionStart=51 expressionEnd=66 fullExpression="${product.name}" jsExpression="product.name"',
    ],
    { detectNonSignalBindings: true },
  );
  tree(
    'non-signal expressions without detectNonSignalBindings',
    '<p title=${product.title} style="width: ${size}px">${product.name}</p>',
    [
      '<p> tag 0-2 open-end 51 close 66-70',
      '  attr title="${product.title}" 3-25 value 9-25',
      '  attr style="width: ${size}px" 26-50 value 33-49',
      '  text "${product.name}" 51-66',
    ],
  );
  tree('namespaced names', '<svg:rect xlink:href="#a"></svg:rect>', [
    '<svg:rect> tag 0-9 open-end 26 close 0-0',
    '  attr xlink:href="#a" 10-25 value 22-24',
    'error @26: Orphaned closing tag </svgrect> with no matching open tag',
    'error @0: Unclosed tag <svg:rect> (reached end of template)',
  ]);
});

describe('when() in a tag', () => {
  tree(
    'before and after other attributes',
    '<p ${when(show())} class="a">x</p><p class="b" ${when(a() && b())}>y</p>',
    [
      '<p> tag 0-2 open-end 29 close 30-34',
      '  when "${when(show())}" 3-18',
      '  attr class="a" 19-28 value 26-27',
      '  text "x" 29-30',
      '<p> tag 34-36 open-end 67 close 68-72',
      '  when "${when(a() && b())}" 47-66',
      '  attr class="b" 37-46 value 44-45',
      '  text "y" 67-68',
      'binding when on <p@0> signalName="show" signalNames=["show"] expressionStart=3 expressionEnd=18 fullExpression="${when(show())}" jsExpression="show()"',
      'binding when on <p@34> signalName="a" signalNames=["a","b"] expressionStart=47 expressionEnd=66 fullExpression="${when(a() && b())}" jsExpression="a() && b()"',
    ],
  );
  tree('braces inside the condition', '<p ${when(pick({ a: on() }))}>x</p>', [
    '<p> tag 0-2 open-end 30 close 31-35',
    '  when "${when(pick({ a: on() }))}" 3-29',
    '  text "x" 30-31',
    'binding when on <p@0> signalName="on" signalNames=["on"] expressionStart=3 expressionEnd=29 fullExpression="${when(pick({ a: on() }))}" jsExpression="pick({ a: on() })"',
  ]);
  tree('on a void element', '<input ${when(on())} value=1>', [
    '<input> tag 0-6 open-end 29 close 29-29 void',
    '  when "${when(on())}" 7-20',
    '  attr value="1" 21-28 value 27-28',
    'binding when on <input@0> signalName="on" signalNames=["on"] expressionStart=7 expressionEnd=20 fullExpression="${when(on())}" jsExpression="on()"',
  ]);
  tree('a quoted brace ends the directive early (no quote awareness, H-12)', "<p ${when(x() === '}')}>a</p>", [
    '<p> tag 0-2 open-end 24 close 25-29',
    '  when "${when(x() === \'}" 3-20',
    '  text "a" 24-25',
  ]);
});

describe('comments and markup declarations', () => {
  tree(
    'comments at the root and inside, with a tag in the comment',
    '<!-- head --><div><!-- a <b> inside --><span>t</span></div><!-- tail -->',
    ['<div> tag 13-17 open-end 18 close 53-59', '  <span> tag 39-44 open-end 45 close 46-53', '    text "t" 45-46'],
  );
  tree('a doctype is text', '<!DOCTYPE html><p>a</p>', ['<p> tag 15-17 open-end 18 close 19-23', '  text "a" 18-19']);
});

describe('void and self-closing tags', () => {
  tree('void, void self-closed, non-void self-closed', '<br><img src="a.png"/><div/><input disabled/><hr />', [
    '<br> tag 0-3 open-end 4 close 4-4 void',
    '<img> tag 4-8 open-end 22 close 22-22 void self-closing',
    '  attr src="a.png" 9-20 value 14-19',
    '<div> tag 22-26 open-end 28 close 28-28 self-closing',
    '<input> tag 28-34 open-end 45 close 45-45 void',
    '  attr disabled="" 35-44 value 44-44',
    '<hr> tag 45-48 open-end 51 close 51-51 void self-closing',
  ]);
  tree('text after a void element belongs to the parent', '<p>a<br>b<img src=x>c</p>', [
    '<p> tag 0-2 open-end 3 close 21-25',
    '  text "a" 3-4',
    '  text "b" 8-9',
    '  text "c" 20-21',
    '  <br> tag 4-7 open-end 8 close 8-8 void',
    '  <img> tag 9-13 open-end 20 close 20-20 void',
    '    attr src="x" 14-19 value 18-19',
  ]);
});

describe('unclosed and orphaned tags', () => {
  tree('implicitly closed and unclosed at the end', '<div><span>text</div><p>open', [
    '<div> tag 0-4 open-end 5 close 15-21',
    '  <span> tag 5-10 open-end 11 close 0-0',
    '    text "text" 11-15',
    '<p> tag 21-23 open-end 24 close 0-0',
    '  text "open" 24-28',
    'warning @5: Unclosed tag <span> (implicitly closed by </div>)',
    'error @21: Unclosed tag <p> (reached end of template)',
  ]);
  tree('orphaned closing tags', '</b><div>x</div></i>', [
    '<div> tag 4-8 open-end 9 close 10-16',
    '  text "x" 9-10',
    'error @0: Orphaned closing tag </b> with no matching open tag',
    'error @16: Orphaned closing tag </i> with no matching open tag',
  ]);
  tree('closing tags match case-insensitively', '<DIV>x</div>', [
    '<DIV> tag 0-4 open-end 5 close 6-12',
    '  text "x" 5-6',
  ]);
});

describe('text', () => {
  tree('text at the root, with bindings', 'hello ${name()} <b>bold</b> tail ${a() + 1}', [
    '<b> tag 16-18 open-end 19 close 23-27',
    '  text "bold" 19-23',
    'binding text on <__root__@0> signalName="name" expressionStart=6 expressionEnd=15 fullExpression="${name()}"',
    'binding text on <__root__@0> signalName="a" signalNames=["a"] expressionStart=33 expressionEnd=43 fullExpression="${a() + 1}" jsExpression="a() + 1"',
  ]);
  tree(
    'bare, complex, whenElse and repeat expressions in one text node',
    '<p>${count()} and ${count() * 2} ${whenElse(on(), html`<i>y</i>`, html`<i>n</i>`)} ${repeat(items(), (it) => html`<li>${it}</li>`)}</p>',
    [
      '<p> tag 0-2 open-end 3 close 131-135',
      '  text "${count()} and ${count() * 2} ${whenElse(on(), html`<i>y</i>`, html`<i>n</i>`)} ${repeat(items(), (it) => html`<li>${it}</li>`)}" 3-131',
      'binding whenElse on <p@0> signalName="on" signalNames=["on"] expressionStart=33 expressionEnd=82 fullExpression="${whenElse(on(), html`<i>y</i>`, html`<i>n</i>`)}" jsExpression="on()" thenTemplate="<i>y</i>" elseTemplate="<i>n</i>"',
      'binding repeat on <p@0> signalName="items" signalNames=["items"] expressionStart=83 expressionEnd=131 fullExpression="${repeat(items(), (it) => html`<li>${it}</li>`)}" itemsExpression="items()" itemVar="it" itemTemplate="<li>${it}</li>"',
      'binding text on <p@0> signalName="count" expressionStart=3 expressionEnd=13 fullExpression="${count()}"',
      'binding text on <p@0> signalName="count" signalNames=["count"] expressionStart=18 expressionEnd=32 fullExpression="${count() * 2}" jsExpression="count() * 2"',
    ],
  );
  tree('< and > inside an expression', '<p>${a() > b() ? "<" : ">"}</p>', [
    '<p> tag 0-2 open-end 3 close 27-31',
    '  text "${a() > b() ? \\"<\\" : \\">\\"}" 3-27',
    'binding text on <p@0> signalName="a" signalNames=["a","b"] expressionStart=3 expressionEnd=27 fullExpression="${a() > b() ? \\"<\\" : \\">\\"}" jsExpression="a() > b() ? \\"<\\" : \\">\\""',
  ]);
  tree('nested template literals', '<p>${`x ${a()} ${`y ${b()}`}`}</p>', [
    '<p> tag 0-2 open-end 3 close 30-34',
    '  text "${`x ${a()} ${`y ${b()}`}`}" 3-30',
    'binding text on <p@0> signalName="a" expressionStart=8 expressionEnd=14 fullExpression="${a()}"',
    'binding text on <p@0> signalName="b" expressionStart=20 expressionEnd=26 fullExpression="${b()}"',
    'binding text on <p@0> signalName="a" signalNames=["a","b"] expressionStart=3 expressionEnd=30 fullExpression="${`x ${a()} ${`y ${b()}`}`}" jsExpression="`x ${a()} ${`y ${b()}`}`"',
  ]);
  tree('an expression with an object literal', '<p>${fmt({ a: n() })}</p>', [
    '<p> tag 0-2 open-end 3 close 21-25',
    '  text "${fmt({ a: n() })}" 3-21',
    'binding text on <p@0> signalName="n" signalNames=["n"] expressionStart=3 expressionEnd=21 fullExpression="${fmt({ a: n() })}" jsExpression="fmt({ a: n() })"',
  ]);
  tree('text split by child elements', '<p>a ${x()} <b>b</b> c ${y()}</p>', [
    '<p> tag 0-2 open-end 3 close 29-33',
    '  text "a ${x()} " 3-12',
    '  text " c ${y()}" 20-29',
    '  <b> tag 12-14 open-end 15 close 16-20',
    '    text "b" 15-16',
    'binding text on <p@0> signalName="x" expressionStart=5 expressionEnd=11 fullExpression="${x()}"',
    'binding text on <p@0> signalName="y" expressionStart=23 expressionEnd=29 fullExpression="${y()}"',
  ]);
});
