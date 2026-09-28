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

describe('same-length reorder pass: rows after the third displaced row', () => {
  // The pass stops after the third displaced row; the move branch then only moves rows. A row
  // further on whose item changed (same key, new object) is therefore not updated and keeps its
  // old value. Found in wave 1; not fixed by H-31, which only decides whether every key exists.
  test('an item changed after the third displaced row is not updated', () => {
    const { reconcile, order, reconciler } = setup();
    const [a, b, c, d, e] = rows('A', 'B', 'C', 'D', 'E');
    reconcile([a!, b!, c!, d!, e!]);
    const e2 = { id: 'E', v: 1 };
    expect(reconcile([c!, a!, b!, e2, d!])).toEqual(['insert C before A', 'insert E before D']);
    expect(order()).toEqual(['C', 'A', 'B', 'E', 'D', 'anchor']);
    expect(reconciler.get('E')!.value).toBe(e!);
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
