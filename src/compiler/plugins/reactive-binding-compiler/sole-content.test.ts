/**
 * Characterisation of sole-content analysis for row text bindings (F0-2 item 9, before TA-7).
 *
 * A row text binding that is the only content of its element is rendered through that
 * element's text node (`textNode`, the element gets the id); otherwise a comment marker is
 * placed before it (`commentMarker`). Until TA-7 the decision was made by
 * `analyzeTextBindingContext`, which scanned the raw row template; since TA-7 it is read from
 * the parse tree (`soleContentParent`, repeat-analysis.ts). The table pins, for each row
 * template, the processed row template (where the id or marker goes) and each item binding's
 * mode. Rows marked "defect" show today's behaviour where it is wrong; rows marked "TA-7"
 * changed with the parse-tree rule (see the TA-7 commits).
 */
import { describe, expect, test } from 'bun:test';
import { processHtmlTemplateWithConditionals } from './template-processing.js';

const analyseRow = (row: string) => {
  const result = processHtmlTemplateWithConditionals(
    '<ul>${repeat(items(), (item) => html`' + row + '`)}</ul>',
    new Map([['items', '[]']]),
    0,
  );
  const repeat = result.repeatBlocks[0]!;
  return {
    template: repeat.itemTemplate,
    bindings: repeat.itemBindings.map((b) => [b.elementId, b.type, b.expression, b.textBindingMode ?? null]),
  };
};

type Case = [
  name: string,
  row: string,
  template: string,
  bindings: Array<[id: string, type: string, expression: string, mode: string | null]>,
];

const table = (cases: Case[]) => {
  for (const [name, row, template, bindings] of cases) {
    test(`${name}: ${row}`, () => {
      expect(analyseRow(row)).toEqual({ template, bindings });
    });
  }
};

describe('sole content: text node', () => {
  table([
    [
      'sole content',
      '<li>${item.name}</li>',
      '<li id="i1">${item.name}</li>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
    [
      'surrounded by whitespace',
      '<li>  ${item.name}  </li>',
      '<li id="i1"> ${item.name} </li>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
    [
      'sole content of a nested element',
      '<div><span>${item.name}</span></div>',
      '<div><span id="i1">${item.name}</span></div>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
    [
      'one binding per cell',
      '<tr><td>${item.a}</td><td>${item.b}</td></tr>',
      '<tr><td id="i1">${item.a}</td><td id="i2">${item.b}</td></tr>',
      [
        ['i1', 'text', 'item.a', 'textNode'],
        ['i2', 'text', 'item.b', 'textNode'],
      ],
    ],
    [
      '< and > inside the expression',
      '<li>${item.a < 2 ? "<" : ">"}</li>',
      '<li id="i1">${item.a < 2 ? "<" : ">"}</li>',
      [['i1', 'text', 'item.a < 2 ? "<" : ">"', 'textNode']],
    ],
    [
      '> inside an attribute expression of the parent (the parent already has an id)',
      '<li title="${x() > 1}">${item.name}</li>',
      '<li id="b1" title="${x()> 1}">${item.name}</li>',
      [['b1', 'text', 'item.name', 'textNode']],
    ],
    [
      'the parent also has an item attribute binding',
      '<li title=${item.t}>${item.name}</li>',
      '<li id="i2" title="${item.t}">${item.name}</li>',
      [
        ['i2', 'text', 'item.name', 'textNode'],
        ['i2', 'attr', 'item.t', null],
      ],
    ],
    [
      'an element with its own sole binding next to a mixed one',
      '<li><span>${item.a}</span>${item.b}</li>',
      '<li><span id="i1">${item.a}</span><!--i2-->${item.b}</li>',
      [
        ['i1', 'text', 'item.a', 'textNode'],
        ['i2', 'text', 'item.b', 'commentMarker'],
      ],
    ],
  ]);
});

describe('sole content: comment marker', () => {
  table([
    [
      'mixed text before',
      '<li>Name: ${item.name}</li>',
      '<li>Name: <!--i1-->${item.name}</li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      'mixed text after (> in the expression)',
      '<li>${item.a > 1 ? "a" : "b"} items</li>',
      '<li><!--i1-->${item.a> 1 ? "a" : "b"} items</li>',
      [['i1', 'text', 'item.a > 1 ? "a" : "b"', 'commentMarker']],
    ],
    [
      'two bindings in one element',
      '<li>${item.a}${item.b}</li>',
      '<li><!--i1-->${item.a}<!--i2-->${item.b}</li>',
      [
        ['i1', 'text', 'item.a', 'commentMarker'],
        ['i2', 'text', 'item.b', 'commentMarker'],
      ],
    ],
    [
      'a sibling element before',
      '<li><b>x</b>${item.name}</li>',
      '<li><b>x</b><!--i1-->${item.name}</li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      'a sibling element after',
      '<li>${item.a}<span></span></li>',
      '<li><!--i1-->${item.a}<span></span></li>',
      [['i1', 'text', 'item.a', 'commentMarker']],
    ],
    [
      'a comment after',
      '<li>${item.name}<!-- c --></li>',
      '<li><!--i1-->${item.name}<!-- c --></li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      'a self-closed void sibling before',
      '<li><br/>${item.name}</li>',
      '<li><br/><!--i1-->${item.name}</li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      'a void sibling after',
      '<li>${item.name}<br></li>',
      '<li><!--i1-->${item.name}<br></li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      'an unclosed tag',
      '<li>${item.name}',
      '<li><!--i1-->${item.name}',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    ['text at the row root', '${item.name}', '<!--i1-->${item.name}', [['i1', 'text', 'item.name', 'commentMarker']]],
  ]);
});

describe('sole content: defects pinned as they are', () => {
  table([
    [
      // Before TA-7 the scan took `<img …>` as the parent and put the text into the void element (H-32)
      'TA-7: a void sibling before gets a comment marker',
      '<li><img src="x">${item.name}</li>',
      '<li><img src="x"><!--i1-->${item.name}</li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      // Before TA-7 the scan took the comment as the parent tag: text-node mode with no element id (H-32)
      'TA-7: a comment before gets a comment marker',
      '<li><!-- c -->${item.name}</li>',
      '<li><!-- c --><!--i1-->${item.name}</li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      // The parser leaves a <p> closed by its parent unclosed, so the parent is <li>, which has a
      // child element. Before TA-7 the scan accepted </li> as the <p>'s close: a text node on <p>
      'TA-7: an element closed by its parent holds nothing',
      '<li><p>${item.a}</li>',
      '<li><p><!--i1-->${item.a}</li>',
      [['i1', 'text', 'item.a', 'commentMarker']],
    ],
    [
      // Until H-12 the row-expression regex stopped at the first `}`: the expression was cut and `)}`
      // was left as row text (K3)
      'H-12: nested braces in the expression',
      '<li>${fmt({ a: item.a })}</li>',
      '<li id="i1">${fmt({ a: item.a })}</li>',
      [['i1', 'text', 'fmt({ a: item.a })', 'textNode']],
    ],
    [
      'H-12: a nested template literal in the expression',
      '<li>${`x${item.a}`}</li>',
      '<li id="i1">${`x${item.a}`}</li>',
      [['i1', 'text', '`x${item.a}`', 'textNode']],
    ],
    [
      'H-12: a brace in a string in the expression, and two levels of braces',
      "<li>${item.on ? '}' : fmt({ a: { b: item.a } })}</li>",
      '<li id="i1">${item.on ? \'}\' : fmt({ a: { b: item.a } })}</li>',
      [['i1', 'text', "item.on ? '}' : fmt({ a: { b: item.a } })", 'textNode']],
    ],
  ]);
});

// Shapes outside the F0-2 table where the scanner's text heuristics misread the parent's tag,
// added before TA-7. The parse tree reads the tag correctly: each binding is the sole content.
describe('sole content: the parent tag as the parser reads it', () => {
  table([
    [
      // Before TA-7 the scan for the end of the open tag stopped at the `>` in the value: comment marker
      'TA-7: a > in a quoted attribute value of the parent',
      '<li title="a>b">${item.name}</li>',
      '<li id="i1" title="a>b">${item.name}</li>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
    [
      'TA-7: a /> in a quoted attribute value of the parent',
      '<li title="a/>">${item.name}</li>',
      '<li id="i1" title="a/>">${item.name}</li>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
    [
      // Before TA-7 the backward scan took `<b">` as the parent: no element got the id, and the
      // build failed in generateStaticRepeatTemplate (THANE202, element path)
      'TA-7: a < in a quoted attribute value of the parent',
      '<li title="a<b">${item.name}</li>',
      '<li id="i1" title="a<b">${item.name}</li>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
    [
      // The same with the < inside an attribute expression; the li's id comes from that binding
      'TA-7: a < in an attribute expression of the parent',
      '<li title="${a() < 1}">${item.name}</li>',
      '<li id="b1" title="${a() < 1}">${item.name}</li>',
      [['b1', 'text', 'item.name', 'textNode']],
    ],
    [
      // Before TA-7 the forward scan only accepted `</name>`: comment marker
      'TA-7: whitespace in the closing tag',
      '<li>${item.name}</li >',
      '<li id="i1">${item.name}</li>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
  ]);
});
