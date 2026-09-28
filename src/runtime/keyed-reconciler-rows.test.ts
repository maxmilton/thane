/**
 * Keyed reconciler behaviour found in wave 1 (RT-5, H-31) and pinned so that later changes keep it
 * until an approved fix changes it. The fake DOM is the one in keyed-reconciler-general.test.ts
 * (copied; that file is not shared).
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

describe('general path: a row element that is no longer in the container', () => {
  // A when() on a row's root element replaces that element with a placeholder when it hides (and
  // with a fresh clone when it shows again), so the row's record keeps an element that left the
  // container. The general path then starts its order walk at the container's first element
  // child, not at the first wanted row's element (checked in Chromium on simplify-w0: the detached
  // rows are inserted before a static first element). RT-5 keeps this start.
  test('the order walk starts at the first element child of the container', () => {
    const head = new FakeNode('head');
    const { list, reconcile, order } = setup({ before: [head] });
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    // what a hidden when() on each row root does: the row element leaves, a placeholder takes its place
    for (const id of ['A', 'B', 'C']) {
      const el = list.childNodes.find((n) => n.name === id)!;
      list.insertBefore(new FakeNode(`tpl-${id}`), el);
      el.remove();
    }
    expect(order()).toEqual(['head', 'tpl-A', 'tpl-B', 'tpl-C', 'anchor']);

    expect(reconcile([c!, a!])).toEqual(['cleanup B', 'insert C before head', 'insert A before head']);
    expect(order()).toEqual(['C', 'A', 'head', 'tpl-A', 'tpl-B', 'tpl-C', 'anchor']);
  });
});

describe('creating rows in an empty list: the container is detached and put back where it is now', () => {
  // A list inside a row is created while that row is the last one; later rows go after it, so
  // the container's next sibling changes. Until H-06 the reconciler put the container back before
  // the sibling it had at creation, which reordered the outer rows (P15).
  test('H-06: a sibling placed after the container since creation stays after it', () => {
    const { list, reconcile, order } = setup();
    const host = list.parentNode!;
    // the next outer row, inserted after the list was created
    host.appendChild(new FakeNode('later'));

    expect(reconcile(rows('A'))).toEqual([
      'remove list',
      'create A@0 at anchor',
      'insert A before anchor',
      'insert list before later',
    ]);
    expect(order()).toEqual(['A', 'anchor']);
    expect(host.childNodes.map((n) => n.name)).toEqual(['list', 'later']);
  });

  test('H-06: a container moved to another parent is put back into that parent', () => {
    const { list, reconcile, order } = setup();
    const moved = new FakeNode('moved');
    moved.appendChild(new FakeNode('head'));
    moved.appendChild(list);
    moved.appendChild(new FakeNode('tail'));

    reconcile(rows('A', 'B'));
    expect(order()).toEqual(['A', 'B', 'anchor']);
    expect(moved.childNodes.map((n) => n.name)).toEqual(['head', 'list', 'tail']);
  });
});

describe('same-length reorder pass: rows after the third displaced row', () => {
  // Until H-48 the pass stopped updating after the third displaced row, and the move branch only
  // moves rows, so a row further on whose item changed (same key, new object) kept its old value
  // (K17, found in wave 1). The pass now updates every row whose item changed, before the moves.
  test('H-48: an item changed after the third displaced row is updated', () => {
    const { reconcile, order, reconciler } = setup();
    const [a, b, c, d, e] = rows('A', 'B', 'C', 'D', 'E');
    reconcile([a!, b!, c!, d!, e!]);
    const e2 = { id: 'E', v: 1 };
    expect(reconcile([c!, a!, b!, e2, d!])).toEqual(['update E@3 v1', 'insert C before A', 'insert E before D']);
    expect(order()).toEqual(['C', 'A', 'B', 'E', 'D', 'anchor']);
    expect(reconciler.get('E')!.value).toBe(e2);
  });

  test('H-48: every changed row is updated once, at its new index, in list order', () => {
    const { reconcile, order } = setup({ trackIndex: true });
    const [a, b, c, d, e, f] = rows('A', 'B', 'C', 'D', 'E', 'F');
    reconcile([a!, b!, c!, d!, e!, f!]);
    const d2 = { id: 'D', v: 1 };
    const f2 = { id: 'F', v: 2 };
    expect(reconcile([d2, c!, b!, a!, f2, e!])).toEqual([
      'update D@0 v1',
      'update F@4 v2',
      'insert D before A',
      'insert C before A',
      'insert B before A',
      'insert F before E',
      // index tracking: the rows at a new position that the pass did not update
      'update C@1 v0',
      'update B@2 v0',
      'update A@3 v0',
      'update E@5 v0',
    ]);
    expect(order()).toEqual(['D', 'C', 'B', 'A', 'F', 'E', 'anchor']);
  });

  test('H-48: rows updated before a missing key are not updated again by the general path', () => {
    const { reconcile, order } = setup();
    const [a, b, c, d, e] = rows('A', 'B', 'C', 'D', 'E');
    reconcile([a!, b!, c!, d!, e!]);
    const d2 = { id: 'D', v: 1 };
    expect(reconcile([c!, a!, b!, d2, ...rows('X')])).toEqual([
      // before H-48 this update came from the general path, after 'remove E'
      'update D@3 v1',
      'cleanup E',
      'remove E',
      'create X@4 at anchor',
      'insert X before anchor',
      'insert A before D',
      'insert B before D',
    ]);
    expect(order()).toEqual(['C', 'A', 'B', 'D', 'X', 'anchor']);
  });

  test('an item changed before the third displaced row is updated', () => {
    const { reconcile, order } = setup();
    const [a, b, c, d, e] = rows('A', 'B', 'C', 'D', 'E');
    reconcile([a!, b!, c!, d!, e!]);
    const a2 = { id: 'A', v: 1 };
    expect(reconcile([c!, a2, b!, e!, d!])).toEqual(['update A@1 v1', 'insert C before A', 'insert E before D']);
    expect(order()).toEqual(['C', 'A', 'B', 'E', 'D', 'anchor']);
  });
});

describe('one row removed: the remove-one fast path', () => {
  // A list one row shorter whose other rows keep their keys and order: the missing row is cleaned
  // up and removed, and with unchanged items nothing else happens (no key map, no moves, no updates).
  test('the first row removed', () => {
    const { reconcile, order } = setup();
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([b!, c!])).toEqual(['cleanup A', 'remove A']);
    expect(order()).toEqual(['B', 'C', 'anchor']);
  });

  test('a middle row removed', () => {
    const { reconcile, order } = setup();
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([a!, c!])).toEqual(['cleanup B', 'remove B']);
    expect(order()).toEqual(['A', 'C', 'anchor']);
  });

  test('the last row removed', () => {
    const { reconcile, order } = setup();
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([a!, b!])).toEqual(['cleanup C', 'remove C']);
    expect(order()).toEqual(['A', 'B', 'anchor']);
  });

  test('the only other row kept: [A, B] → [B] and [A, B] → [A]', () => {
    const first = setup();
    const [a, b] = rows('A', 'B');
    first.reconcile([a!, b!]);
    expect(first.reconcile([b!])).toEqual(['cleanup A', 'remove A']);
    expect(first.order()).toEqual(['B', 'anchor']);

    const last = setup();
    last.reconcile([a!, b!]);
    expect(last.reconcile([a!])).toEqual(['cleanup B', 'remove B']);
    expect(last.order()).toEqual(['A', 'anchor']);
  });

  test('static nodes around the rows stay in place', () => {
    const { reconcile, order } = setup({ before: [new FakeNode('head')], after: [new FakeNode('tail')] });
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([a!, c!])).toEqual(['cleanup B', 'remove B']);
    expect(order()).toEqual(['head', 'A', 'C', 'anchor', 'tail']);
  });

  test('with index tracking, every row after the removed one is updated with its new index, in list order', () => {
    const { reconcile, order } = setup({ trackIndex: true });
    const [a, b, c, d] = rows('A', 'B', 'C', 'D');
    reconcile([a!, b!, c!, d!]);
    expect(reconcile([a!, c!, d!])).toEqual(['cleanup B', 'remove B', 'update C@1 v0', 'update D@2 v0']);
    expect(order()).toEqual(['A', 'C', 'D', 'anchor']);
  });

  test('the removed key is forgotten by get() once the key map is built', () => {
    const { reconcile, reconciler } = setup();
    const [a, b, c, d] = rows('A', 'B', 'C', 'D');
    reconcile([a!, b!, c!, d!]);
    for (const id of ['A', 'B', 'C', 'D', 'A']) reconciler.get(id); // the fifth lookup builds the map
    expect(reconcile([a!, b!, d!])).toEqual(['cleanup C', 'remove C']);
    expect(reconciler.get('C')).toBeUndefined();
    expect(reconciler.get('D')!.value).toBe(d);
  });

  // Until H-51 this path updated no kept row, so a kept row whose item changed (same key, new object)
  // kept its old item, and with index tracking the index update re-applied the old item (K22). Kept
  // rows are now matched as in the in-place pass: a changed item is updated at its new index, before
  // the removal.
  test('H-51: kept rows whose item changed are updated at their new index', () => {
    const { reconcile, reconciler, order } = setup();
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    const a2 = { id: 'A', v: 1 };
    const c2 = { id: 'C', v: 2 };
    expect(reconcile([a2, c2])).toEqual(['update A@0 v1', 'update C@1 v2', 'cleanup B', 'remove B']);
    expect(order()).toEqual(['A', 'C', 'anchor']);
    expect(reconciler.get('A')!.value).toBe(a2);
    expect(reconciler.get('C')!.value).toBe(c2);
  });

  test('H-51: with index tracking, a changed row is updated once, with its new item and index', () => {
    const { reconcile, reconciler, order } = setup({ trackIndex: true });
    const [a, b, c, d] = rows('A', 'B', 'C', 'D');
    reconcile([a!, b!, c!, d!]);
    const c2 = { id: 'C', v: 1 };
    expect(reconcile([a!, c2, d!])).toEqual([
      'update C@1 v1',
      'cleanup B',
      'remove B',
      // index tracking: the row at a new position that was not updated above
      'update D@2 v0',
    ]);
    expect(order()).toEqual(['A', 'C', 'D', 'anchor']);
    expect(reconciler.get('C')!.value).toBe(c2);
  });

  test('H-51: a changed row before the removed one is updated once, at its unchanged index', () => {
    const { reconcile, order } = setup({ trackIndex: true });
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([{ id: 'A', v: 1 }, b!])).toEqual(['update A@0 v1', 'cleanup C', 'remove C']);
    expect(order()).toEqual(['A', 'B', 'anchor']);
  });

  test('H-51: a row updated before the general path takes over is not updated again', () => {
    const { reconcile, order, reconciler } = setup({ trackIndex: true });
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    const b2 = { id: 'B', v: 1 };
    expect(reconcile([b2, ...rows('X')])).toEqual([
      // matched one position down before X shows that more than one row changed
      'update B@0 v1',
      'cleanup A',
      'remove A',
      'cleanup C',
      'remove C',
      'create X@1 at anchor',
      'insert X before anchor',
    ]);
    expect(order()).toEqual(['B', 'X', 'anchor']);
    expect(reconciler.get('B')!.value).toBe(b2);
  });
});

describe('one row fewer, but not one row removed (K21)', () => {
  // Until H-50 the remove-one fast path removed the first row whose key differed and returned without
  // checking the rows after it. Every shape below is a list one row shorter whose remaining keys do not
  // match the old rows after the removed one; the fast path now sees that and the general path runs.
  test('H-50: [A, B] → [G] removes both rows and creates G', () => {
    const { reconcile, order } = setup();
    reconcile(rows('A', 'B'));
    expect(reconcile(rows('G'))).toEqual([
      'cleanup A',
      'remove A',
      'cleanup B',
      'remove B',
      'create G@0 at anchor',
      'insert G before anchor',
    ]);
    expect(order()).toEqual(['G', 'anchor']);
    // the removed rows' cleanups ran once: clearing the list runs only G's
    expect(reconcile([])).toEqual(['cleanup G', 'remove anchor', 'clear list', 'insert anchor before end']);
  });

  test('H-50: [A, B, C] → [B, X] removes A and C and creates X', () => {
    const { reconcile, order, reconciler } = setup();
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([b!, ...rows('X')])).toEqual([
      'cleanup A',
      'remove A',
      'cleanup C',
      'remove C',
      'create X@1 at anchor',
      'insert X before anchor',
    ]);
    expect(order()).toEqual(['B', 'X', 'anchor']);
    expect(reconciler.get('A')).toBeUndefined();
    expect(reconciler.get('C')).toBeUndefined();
    expect(reconcile([])).toEqual([
      'cleanup B',
      'cleanup X',
      'remove anchor',
      'clear list',
      'insert anchor before end',
    ]);
  });

  test('H-50: [A, B, C] → [A, X] removes B and C and creates X', () => {
    const { reconcile, order } = setup();
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([a!, ...rows('X')])).toEqual([
      'cleanup B',
      'remove B',
      'cleanup C',
      'remove C',
      'create X@1 at anchor',
      'insert X before anchor',
    ]);
    expect(order()).toEqual(['A', 'X', 'anchor']);
  });

  test('H-50: [A, B, C] → [C, B] removes A and puts B after C', () => {
    const { reconcile, order } = setup();
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([c!, b!])).toEqual(['cleanup A', 'remove A', 'insert B before anchor']);
    expect(order()).toEqual(['C', 'B', 'anchor']);
  });

  test('H-50: with index tracking, a kept row at a new position is updated with its index', () => {
    const { reconcile, order } = setup({ trackIndex: true });
    const [a, b, c] = rows('A', 'B', 'C');
    reconcile([a!, b!, c!]);
    expect(reconcile([b!, ...rows('X')])).toEqual([
      'cleanup A',
      'remove A',
      'cleanup C',
      'remove C',
      'create X@1 at anchor',
      'insert X before anchor',
      'update B@0 v0',
    ]);
    expect(order()).toEqual(['B', 'X', 'anchor']);
  });
});
