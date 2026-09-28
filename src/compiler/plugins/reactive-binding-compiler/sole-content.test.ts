/**
 * Characterisation of sole-content analysis for row text bindings (F0-2 item 9, before TA-7).
 *
 * A row text binding that is the only content of its element is rendered through that
 * element's text node (`textNode`, the element gets the id); otherwise a comment marker is
 * placed before it (`commentMarker`). The decision is made by `analyzeTextBindingContext`
 * (repeat-analysis.ts), which scans the raw row template. The table pins, for each row
 * template, the processed row template (where the id or marker goes) and each item binding's
 * mode. Rows marked "defect" show today's behaviour where it is wrong; TA-7's parse-tree version
 * changes some of them (see the hand-off note).
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
      '<li id="i1">${item$().name}</li>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
    [
      'surrounded by whitespace',
      '<li>  ${item.name}  </li>',
      '<li id="i1"> ${item$().name} </li>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
    [
      'sole content of a nested element',
      '<div><span>${item.name}</span></div>',
      '<div><span id="i1">${item$().name}</span></div>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
    [
      'one binding per cell',
      '<tr><td>${item.a}</td><td>${item.b}</td></tr>',
      '<tr><td id="i1">${item$().a}</td><td id="i2">${item$().b}</td></tr>',
      [
        ['i1', 'text', 'item.a', 'textNode'],
        ['i2', 'text', 'item.b', 'textNode'],
      ],
    ],
    [
      '< and > inside the expression',
      '<li>${item.a < 2 ? "<" : ">"}</li>',
      '<li id="i1">${item$().a < 2 ? "<" : ">"}</li>',
      [['i1', 'text', 'item.a < 2 ? "<" : ">"', 'textNode']],
    ],
    [
      '> inside an attribute expression of the parent (the parent already has an id)',
      '<li title="${x() > 1}">${item.name}</li>',
      '<li id="b1" title="${x()> 1}">${item$().name}</li>',
      [['b1', 'text', 'item.name', 'textNode']],
    ],
    [
      'the parent also has an item attribute binding',
      '<li title=${item.t}>${item.name}</li>',
      '<li id="i2" title="${item$().t}">${item$().name}</li>',
      [
        ['i2', 'text', 'item.name', 'textNode'],
        ['i2', 'attr', 'item.t', null],
      ],
    ],
    [
      'an element with its own sole binding next to a mixed one',
      '<li><span>${item.a}</span>${item.b}</li>',
      '<li><span id="i1">${item$().a}</span><!--i2-->${item$().b}</li>',
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
      '<li>Name: <!--i1-->${item$().name}</li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      'mixed text after (> in the expression)',
      '<li>${item.a > 1 ? "a" : "b"} items</li>',
      '<li><!--i1-->${item$().a> 1 ? "a" : "b"} items</li>',
      [['i1', 'text', 'item.a > 1 ? "a" : "b"', 'commentMarker']],
    ],
    [
      'two bindings in one element',
      '<li>${item.a}${item.b}</li>',
      '<li><!--i1-->${item$().a}<!--i2-->${item$().b}</li>',
      [
        ['i1', 'text', 'item.a', 'commentMarker'],
        ['i2', 'text', 'item.b', 'commentMarker'],
      ],
    ],
    [
      'a sibling element before',
      '<li><b>x</b>${item.name}</li>',
      '<li><b>x</b><!--i1-->${item$().name}</li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      'a sibling element after',
      '<li>${item.a}<span></span></li>',
      '<li><!--i1-->${item$().a}<span></span></li>',
      [['i1', 'text', 'item.a', 'commentMarker']],
    ],
    [
      'a comment after',
      '<li>${item.name}<!-- c --></li>',
      '<li><!--i1-->${item$().name}<!-- c --></li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      'a self-closed void sibling before',
      '<li><br/>${item.name}</li>',
      '<li><br/><!--i1-->${item$().name}</li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      'a void sibling after',
      '<li>${item.name}<br></li>',
      '<li><!--i1-->${item$().name}<br></li>',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      'an unclosed tag',
      '<li>${item.name}',
      '<li><!--i1-->${item$().name}',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
    [
      'text at the row root',
      '${item.name}',
      '<!--i1-->${item$().name}',
      [['i1', 'text', 'item.name', 'commentMarker']],
    ],
  ]);
});

describe('sole content: defects pinned as they are', () => {
  table([
    [
      // The backward scan takes `<img …>` as the parent: the id goes on the void element
      'defect: a void sibling before is taken as the parent',
      '<li><img src="x">${item.name}</li>',
      '<li><img id="i1" src="x">${item$().name}</li>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
    [
      // The backward scan takes the comment as the parent tag: text-node mode, but no element gets the id
      'defect: a comment before is taken as the parent',
      '<li><!-- c -->${item.name}</li>',
      '<li><!-- c -->${item$().name}</li>',
      [['i1', 'text', 'item.name', 'textNode']],
    ],
    [
      // Any closing tag ends the forward scan, so the unclosed <p> counts as closed by </li>
      'an unclosed element closed by its parent counts as closed',
      '<li><p>${item.a}</li>',
      '<li><p id="i1">${item$().a}</li>',
      [['i1', 'text', 'item.a', 'textNode']],
    ],
    [
      // The row-expression regex stops at the first `}`: the expression is cut and `)}` is left as row text
      'defect: nested braces in the expression',
      '<li>${fmt({ a: item.a })}</li>',
      '<li><!--i1-->${fmt({ a: item$().a })})}</li>',
      [['i1', 'text', 'fmt({ a: item.a', 'commentMarker']],
    ],
    [
      'defect: a nested template literal in the expression',
      '<li>${`x${item.a}`}</li>',
      '<li><!--i1-->${`x${item$().a}`}</li>',
      [['i1', 'text', '`x${item.a', 'commentMarker']],
    ],
  ]);
});
