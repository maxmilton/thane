import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import {
  compileCssTemplate,
  countCssClass,
  declaresOwnCssTag,
  isCssTaggedTemplate,
  renameCssClasses,
  transformCss,
} from './css-transform.js';
import { minifyCSS, minifyHTML } from './template-minifier.js';
import { SelectorMap } from './selector-minifier.js';

const mapOf = (...selectors: string[]): SelectorMap => {
  const map = new SelectorMap();
  for (const selector of selectors) map.register(selector);
  return map;
};

/** Compile the first css`` template of a source text. */
const compile = (source: string, options: Parameters<typeof compileCssTemplate>[2]): string => {
  const sourceFile = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: ts.TaggedTemplateExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isCssTaggedTemplate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error('no css template in the fixture');
  return compileCssTemplate(found, sourceFile, options);
};

describe('minifyCSS', () => {
  test('removes comments, line breaks and the spaces CSS never needs', () => {
    expect(minifyCSS('/* note */\n.a ,\n.b > .c {\n  color : red ;\n  margin: 0 auto;\n}\n')).toBe(
      '.a,.b>.c{color :red;margin:0 auto}',
    );
  });

  test('keeps the spaces calc() needs around + and -', () => {
    expect(minifyCSS('.a { width: calc(100% - 2 * (1px + 2px)); }')).toBe('.a{width:calc(100% - 2 * (1px + 2px))}');
  });

  test('keeps the descendant combinator in front of a pseudo-class', () => {
    expect(minifyCSS('.a :hover { color: red; }')).toBe('.a :hover{color:red}');
    expect(minifyCSS('.a:hover { color: red; }')).toBe('.a:hover{color:red}');
  });

  test('copies quoted strings verbatim', () => {
    expect(minifyCSS('.a::before { content: "a  {  b }  /* c */"; }')).toBe('.a::before{content:"a  {  b }  /* c */"}');
    expect(minifyCSS(".a { font-family: 'My  Font' , serif; }")).toBe(".a{font-family:'My  Font',serif}");
  });

  test('keeps media query conditions intact', () => {
    expect(minifyCSS('@media (min-width: 600px) and (max-width: 900px) { .a { color: red; } }')).toBe(
      '@media (min-width:600px) and (max-width:900px){.a{color:red}}',
    );
  });
});

describe('minifyHTML', () => {
  test('collapses whitespace between elements and inside text', () => {
    expect(minifyHTML('\n  <div>\n    <p>Body   text</p>\n  </div>\n')).toBe('<div><p>Body text</p></div>');
  });

  test('carries preformatted text through exactly as written', () => {
    expect(minifyHTML('<div>\n  <pre>line 1\n    line 2</pre>\n  <p>a   b</p>\n</div>')).toBe(
      '<div> <pre>line 1\n    line 2</pre> <p>a b</p></div>',
    );
    const form = '<textarea>\n  keep\n</textarea>';
    expect(minifyHTML(form)).toBe(form);
  });

  test('never reads an inline script or stylesheet as HTML', () => {
    const script = '<script>\n  // a comment ends at the line break\n  start();\n</script>';
    const style = '<style>\n  .a > .b { width: calc(1px + 2px); }\n</style>';
    const page = `<head>\n  ${script}\n  ${style}\n</head>`;
    const minified = minifyHTML(page);
    expect(minified).toContain(script);
    expect(minified).toContain(style);
  });

  test('keeps binding markers and drops ordinary comments', () => {
    const minified = minifyHTML('<div>\n  <!--b12--> <!---->\n  <!-- dev note -->\n</div>');
    expect(minified).toContain('<!--b12--> <!---->');
    expect(minified).not.toContain('dev note');
  });
});

describe('CSS class renaming', () => {
  test('renames class selectors and nothing else', () => {
    const css = [
      '.my-card { color: red; }',
      '.my-card.active > .my-card-title { }',
      'my-card { }',
      '#my-card { }',
      '[data-x="my-card"] { }',
      '.other::after { content: ".my-card"; }',
      '.bg { background: url(/img/photo.my-card.png); }',
      '.bg2 { background: url("/img/.my-card"); }',
      '/* .my-card in a comment */',
    ].join('\n');
    const renamed = renameCssClasses(css, (name) => (name === 'my-card' ? 'a-a' : undefined));
    expect(renamed).toBe(
      [
        '.a-a { color: red; }',
        '.a-a.active > .my-card-title { }',
        'my-card { }',
        '#my-card { }',
        '[data-x="my-card"] { }',
        '.other::after { content: ".my-card"; }',
        '.bg { background: url(/img/photo.my-card.png); }',
        '.bg2 { background: url("/img/.my-card"); }',
        '/* .my-card in a comment */',
      ].join('\n'),
    );
    expect(countCssClass(css, 'my-card')).toBe(2);
  });

  test('a class name continued by a substitution is not that class', () => {
    expect(countCssClass('.my-card${size} { }', 'my-card')).toBe(0);
    expect(countCssClass('.my-card ${rest}', 'my-card')).toBe(1);
  });

  test('transformCss returns the text untouched when there is nothing to do', () => {
    const css = '.a {\n  color: red;\n}\n';
    expect(transformCss(css, {})).toBe(css);
    expect(transformCss(css, { minify: false, selectorMap: new SelectorMap() })).toBe(css);
  });
});

describe('compileCssTemplate', () => {
  test('a development build only drops the tag', () => {
    expect(compile('const s = css`\n  .a { color: red; }\n`;', {})).toBe('`\n  .a { color: red; }\n`');
  });

  test('substitutions are carried over untouched, whatever they contain', () => {
    const source =
      "const s = css`\n  .a {\n    color: ${dark ? '}  {  ;' : `x   ${y}   z`};\n    margin: ${a} ${b};\n  }\n`;";
    expect(compile(source, { minify: true })).toBe("`.a{color:${dark ? '}  {  ;' : `x   ${y}   z`};margin:${a} ${b}}`");
  });

  test('escape sequences stay exactly as written', () => {
    const source = 'const s = css`.a::before { content: "\\\\201C"; }`;';
    expect(source).toContain('"\\\\201C"');
    expect(compile(source, { minify: true })).toBe('`.a::before{content:"\\\\201C"}`');
  });

  test('host classes are renamed around substitutions', () => {
    const source = 'const s = css`.my-card { color: ${c}; } .my-card${suffix} { } .x { content: ".my-card"; }`;';
    expect(compile(source, { selectorMap: mapOf('my-card') })).toBe(
      '`.a-a { color: ${c}; } .my-card${suffix} { } .x { content: ".my-card"; }`',
    );
  });

  test('a css template nested in a substitution is compiled too', () => {
    const source = 'const s = css`.a { } ${on ? css`.b {  color: red;  }` : ""}`;';
    expect(compile(source, { minify: true })).toBe('`.a{}${on ? `.b{color:red}` : ""}`');
  });
});

describe('declaresOwnCssTag', () => {
  const parse = (source: string): ts.SourceFile =>
    ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, false);

  test('the global tag and the import from thane belong to Thane', () => {
    expect(declaresOwnCssTag(parse('export const s = css`.a{}`;'))).toBe(false);
    expect(declaresOwnCssTag(parse("import { css } from 'thane';\nexport const s = css`.a{}`;"))).toBe(false);
  });

  test('a css tag from anywhere else is not', () => {
    expect(declaresOwnCssTag(parse("import { css } from 'some-lib';"))).toBe(true);
    expect(declaresOwnCssTag(parse("import { styled as css } from 'some-lib';"))).toBe(true);
    expect(declaresOwnCssTag(parse("import css from 'some-lib';"))).toBe(true);
    expect(declaresOwnCssTag(parse('const css = (s: TemplateStringsArray) => s.join("");'))).toBe(true);
    expect(declaresOwnCssTag(parse('function css() {}'))).toBe(true);
  });
});
