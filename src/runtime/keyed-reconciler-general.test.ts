/**
 * Characterisation of the keyed reconciler's general path (F0-2 item 3, before RT-5).
 *
 * The general path runs when a reconcile is neither an append, a single removal, an in-place
 * update, a pure reorder nor a complete same-length replacement. These tests pin the final DOM
 * order and the exact sequence of DOM operations, cleanups, creations and updates, with static
 * nodes around the rows. Unlike keyed-reconciler.test.ts, the fake DOM here distinguishes element
 * from non-element nodes, so `nextElementSibling` / `previousElementSibling` / `firstElementChild`
 * skip comments and text as a browser does.
 */
import { describe, expect, test } from 'bun:test';
import { createKeyedReconciler } from './dom-binding.js';

let ops: string[] = [];

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  constructor(
    public readonly name: string,
    public readonly isElement = true,
  ) {}

  get ownerDocument(): { createDocumentFragment: () => FakeNode } {
    return { createDocumentFragment: () => new FakeNode('#fragment', false) };
  }
  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get nextElementSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    for (let i = siblings.indexOf(this) + 1; i < siblings.length; i++) if (siblings[i]!.isElement) return siblings[i]!;
    return null;
  }
  get previousElementSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    for (let i = siblings.indexOf(this) - 1; i >= 0; i--) if (siblings[i]!.isElement) return siblings[i]!;
    return null;
  }
  get firstElementChild(): FakeNode | null {
    return this.childNodes.find((n) => n.isElement) ?? null;
  }
  set textContent(_value: string) {
    ops.push(`clear ${this.name}`);
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
  }
  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    if (this.name !== '#fragment') ops.push(`insert ${child.name} before ${ref ? ref.name : 'end'}`);
    if (child.parentNode) child.detach();
    child.parentNode = this;
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at === -1) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    return child;
  }
  remove(): void {
    if (!this.parentNode) return;
    ops.push(`remove ${this.name}`);
    this.detach();
  }
  private detach(): void {
    const siblings = this.parentNode!.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
}

interface Row {
  id: string;
  v: number;
}

/**
 * A list container with optional static nodes before the rows and after the anchor, the way
 * compiled templates lay them out (`<ul><li>head</li>${repeat(…)}<li>tail</li></ul>`).
 */
const setup = (layout: { before?: FakeNode[]; after?: FakeNode[]; trackIndex?: boolean } = {}) => {
  const host = new FakeNode('host');
  const list = new FakeNode('list');
  const anchor = new FakeNode('anchor');
  host.appendChild(list);
  for (const n of layout.before ?? []) list.appendChild(n);
  list.appendChild(anchor);
  for (const n of layout.after ?? []) list.appendChild(n);

  const reconciler = createKeyedReconciler<Row>(
    list as unknown as ParentNode & Element,
    anchor as unknown as Element,
    (item, index, refNode) => {
      ops.push(`create ${item.id}@${index} at ${(refNode as unknown as FakeNode).name}`);
      const el = new FakeNode(item.id);
      list.insertBefore(el, refNode as unknown as FakeNode);
      return {
        el: el as unknown as Element,
        cleanups: [() => ops.push(`cleanup ${item.id}`)],
        value: item,
        update: (next: Row, i: number) => ops.push(`update ${next.id}@${i} v${next.v}`),
      };
    },
    'id',
    undefined,
    layout.trackIndex,
  );
  const order = () => list.childNodes.map((n) => n.name);
  const reconcile = (items: Row[]) => {
    ops = [];
    reconciler.reconcile(items);
    return ops;
  };
  return { list, anchor, reconciler, order, reconcile };
};

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, v: 0 }));

describe('general path: a new first row', () => {
  test('growth with a new first key', () => {
    const { reconcile, order } = setup();
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([...rows('X'), a!, b!, c!])).toEqual([
      'create X@0 at A',
      'insert X before A',
      // X was inserted before A, so the order walk starts at X and moves nothing
    ]);
    expect(order()).toEqual(['X', 'A', 'B', 'C', 'anchor']);
  });

  test('same length, first row replaced by a new key (the last key still exists)', () => {
    const { reconcile, order } = setup();
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([...rows('X'), b!, c!])).toEqual([
      'cleanup A',
      'remove A',
      'create X@0 at B',
      'insert X before B',
    ]);
    expect(order()).toEqual(['X', 'B', 'C', 'anchor']);
  });
});

describe('general path: the first row moves', () => {
  test('same length with one key replaced: the reorder pass updates first, then removals, creations, moves', () => {
    const { reconcile, order } = setup();
    const [a, b, c, d] = rows('A', 'B', 'C', 'D');
    reconcile([a!, b!, c!, d!]);
    const b2 = { id: 'B', v: 1 };
    expect(reconcile([b2, a!, ...rows('X'), c!])).toEqual([
      // updated by the same-length reorder pass before it meets the missing key, and not again
      'update B@0 v1',
      'cleanup D',
      'remove D',
      // a new row is created before the kept row at its index, not before its final neighbour
      'create X@2 at C',
      'insert X before C',
      'insert A before X',
    ]);
    expect(order()).toEqual(['B', 'A', 'X', 'C', 'anchor']);
  });

  test('growth where the old first row ends up last', () => {
    const { reconcile, order } = setup();
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([b!, c!, ...rows('Y'), a!])).toEqual([
      'create Y@2 at C',
      'insert Y before C',
      // the order walk starts at B (the first wanted row), so A is moved last, not B and C first
      'insert C before Y',
      'insert A before anchor',
    ]);
    expect(order()).toEqual(['B', 'C', 'Y', 'A', 'anchor']);
  });

  test('with index tracking, every row at a new position is updated after the moves, in list order', () => {
    const { reconcile, order } = setup({ trackIndex: true });
    const [a, b, c, d] = rows('A', 'B', 'C', 'D');
    reconcile([a!, b!, c!, d!]);
    const log = reconcile([c!, ...rows('X'), a!]);
    expect(log).toEqual([
      'cleanup B',
      'remove B',
      'cleanup D',
      'remove D',
      'create X@1 at C',
      'insert X before C',
      'insert X before anchor',
      'insert A before anchor',
      'update C@0 v0',
      'update A@2 v0',
    ]);
    expect(order()).toEqual(['C', 'X', 'A', 'anchor']);
  });
});

describe('general path: all new rows, different length', () => {
  test('every old row is cleaned up and removed, then the new rows are created before the anchor', () => {
    const { reconcile, order } = setup();
    reconcile(rows('A', 'B'));
    expect(reconcile(rows('X', 'Y', 'Z'))).toEqual([
      'cleanup A',
      'remove A',
      'cleanup B',
      'remove B',
      'create X@0 at anchor',
      'insert X before anchor',
      'create Y@1 at anchor',
      'insert Y before anchor',
      'create Z@2 at anchor',
      'insert Z before anchor',
    ]);
    expect(order()).toEqual(['X', 'Y', 'Z', 'anchor']);
  });

  test('shrinking to all new rows works the same way', () => {
    const { reconcile, order } = setup();
    reconcile(rows('A', 'B', 'C'));
    expect(reconcile(rows('X'))).toEqual([
      'cleanup A',
      'remove A',
      'cleanup B',
      'remove B',
      'cleanup C',
      'remove C',
      'create X@0 at anchor',
      'insert X before anchor',
    ]);
    expect(order()).toEqual(['X', 'anchor']);
  });

  test('same length, all new: the complete-replacement path clears the container instead', () => {
    const { reconcile, order } = setup();
    reconcile(rows('A', 'B'));
    expect(reconcile(rows('X', 'Y'))).toEqual([
      'cleanup A',
      'cleanup B',
      'remove anchor',
      'clear list',
      'insert anchor before end',
      // bulkCreate on an empty list detaches the container while the rows go in
      'remove list',
      'create X@0 at anchor',
      'insert X before anchor',
      'create Y@1 at anchor',
      'insert Y before anchor',
      'insert list before end',
    ]);
    expect(order()).toEqual(['X', 'Y', 'anchor']);
  });
});

describe('general path with static nodes around the rows', () => {
  const statics = () => ({
    before: [new FakeNode('head'), new FakeNode('#comment', false)],
    after: [new FakeNode('#text', false), new FakeNode('tail')],
  });

  test('a static element before the rows stays in place through a general reorder', () => {
    const { reconcile, order } = setup(statics());
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(order()).toEqual(['head', '#comment', 'A', 'B', 'C', 'anchor', '#text', 'tail']);
    expect(reconcile([c!, ...rows('X'), a!])).toEqual([
      'cleanup B',
      'remove B',
      'create X@1 at C',
      'insert X before C',
      'insert X before anchor',
      'insert A before anchor',
    ]);
    expect(order()).toEqual(['head', '#comment', 'C', 'X', 'A', 'anchor', '#text', 'tail']);
  });

  test('a new first row lands after the static element, before the old first row', () => {
    const { reconcile, order } = setup(statics());
    const [a, b] = rows('A', 'B');
    reconcile([a!, b!]);
    expect(reconcile([...rows('X'), b!, a!, ...rows('Y')])).toEqual([
      'create X@0 at A',
      'insert X before A',
      'create Y@3 at anchor',
      'insert Y before anchor',
      'insert B before A',
    ]);
    expect(order()).toEqual(['head', '#comment', 'X', 'B', 'A', 'Y', 'anchor', '#text', 'tail']);
  });

  test('all new rows with a different length keep both static elements', () => {
    const { reconcile, order } = setup(statics());
    reconcile(rows('A', 'B'));
    reconcile(rows('X', 'Y', 'Z'));
    expect(order()).toEqual(['head', '#comment', 'X', 'Y', 'Z', 'anchor', '#text', 'tail']);
  });

  test('a complete same-length replacement deletes every static node in the container (P18, H-05)', () => {
    const { reconcile, order } = setup(statics());
    reconcile(rows('A', 'B'));
    reconcile(rows('X', 'Y'));
    expect(order()).toEqual(['X', 'Y', 'anchor']);
  });

  test('clearing the list deletes every static node in the container (P18, H-05)', () => {
    const { reconcile, order } = setup(statics());
    reconcile(rows('A', 'B'));
    reconcile([]);
    expect(order()).toEqual(['anchor']);
  });
});

describe('same-length reorder pass: more than two displaced rows before a new key', () => {
  // Until H-31 the reorder pass stopped after the third displaced row (`mismatchCount > 2`)
  // without checking the remaining keys, took the "all keys exist" branch and threw a TypeError
  // part-way through the moves (K1). It now checks every key first, so a missing one sends the
  // update to the general path.
  test('H-31: the general path runs: the missing row is cleaned up, the new one created', () => {
    const { reconcile, order } = setup();
    const [a, b, c, d] = rows('A', 'B', 'C', 'D');
    reconcile([a!, b!, c!, d!]);
    expect(reconcile([c!, a!, b!, ...rows('X')])).toEqual([
      'cleanup D',
      'remove D',
      'create X@3 at anchor',
      'insert X before anchor',
      'insert A before X',
      'insert B before X',
    ]);
    expect(order()).toEqual(['C', 'A', 'B', 'X', 'anchor']);

    reconcile(rows('P', 'Q'));
    expect(order()).toEqual(['P', 'Q', 'anchor']);
  });

  test('H-31: a row updated by the pass is not updated again by the general path', () => {
    const { reconcile, order } = setup();
    const [a, b, c, d] = rows('A', 'B', 'C', 'D');
    reconcile([a!, b!, c!, d!]);
    const b2 = { id: 'B', v: 2 };
    expect(reconcile([b2, c!, a!, ...rows('X')])).toEqual([
      'update B@0 v2',
      'cleanup D',
      'remove D',
      'create X@3 at anchor',
      'insert X before anchor',
      'insert A before X',
    ]);
    expect(order()).toEqual(['B', 'C', 'A', 'X', 'anchor']);
  });

  test('two displaced rows before the new key take the general path instead', () => {
    const { reconcile, order } = setup();
    const [a, b, c, d] = rows('A', 'B', 'C', 'D');
    reconcile([a!, b!, c!, d!]);
    reconcile([b!, a!, ...rows('X'), d!]);
    expect(order()).toEqual(['B', 'A', 'X', 'D', 'anchor']);
  });
});
