/**
 * DOM Binding utilities — conditional rendering and repeat directives.
 */

import type { Signal } from './types.js';

/** Lazy template element for HTML parsing. */
let tempEl: HTMLTemplateElement | null = null;
const getTempEl = (): HTMLTemplateElement => {
  if (!tempEl) {
    tempEl = document.createElement('template');
  }
  return tempEl;
};

/**
 * @internal — Core conditional binding (when/whenElse). The content sits between two comment
 * anchors, with any number of root nodes; whatever is between them when the binding starts is
 * the pre-rendered content. `initNested` receives the content's first node.
 */
const bindConditional = (
  start: Node,
  end: Node,
  template: string,
  initNested: (first: Node) => (() => void)[],
  signals: Signal<any>[],
  evalCondition: () => unknown,
): (() => void) => {
  let showing = start.nextSibling !== end;
  let cleanups: (() => void)[] = showing ? initNested(start.nextSibling!) : [];

  const update = () => {
    if (evalCondition()) {
      if (showing) return;
      showing = true;
      const tpl = getTempEl();
      tpl.innerHTML = template;
      end.parentNode!.insertBefore(tpl.content, end);
      cleanups = initNested(start.nextSibling!);
    } else if (showing) {
      showing = false;
      // Everything between the anchors goes: the content, and rows, nested branches and child
      // hosts that ended up at its top level
      for (let n = start.nextSibling; n !== end; n = start.nextSibling) (n as ChildNode).remove();
      // Dispose nested subscriptions so hidden effects don't
      // fire against detached DOM. Re-initialized on next show().
      for (let i = 0; i < cleanups.length; i++) cleanups[i]!();
      cleanups = [];
    }
  };

  const unsubscribes = signals.map((s) => s.subscribe(update, true));
  update();

  return () => {
    for (let i = 0; i < unsubscribes.length; i++) unsubscribes[i]!();
    for (let i = 0; i < cleanups.length; i++) cleanups[i]!();
    cleanups = [];
  };
};

export const __bindIf = (
  start: Node,
  end: Node,
  signal: Signal<any>,
  template: string,
  initNested: (first: Node) => (() => void)[],
): (() => void) => bindConditional(start, end, template, initNested, [signal], signal);

export const __bindIfExpr = (
  start: Node,
  end: Node,
  signals: Signal<any>[],
  evalExpr: () => boolean,
  template: string,
  initNested: (first: Node) => (() => void)[],
): (() => void) => bindConditional(start, end, template, initNested, signals, evalExpr);

// ─────────────────────────────────────────────────────────────
//  Keyed Reconciler
// ─────────────────────────────────────────────────────────────

/** Managed item in a repeat directive. */
interface ManagedItem<T> {
  el: Element;
  cleanups: (() => void)[];
  /** Direct update function used when available */
  update?: ((newValue: T, index: number) => void) | undefined;
  /** Cached value for direct update path (no signal) */
  value?: T | undefined;
  /** Cached key — avoids re-calling keyFn on old items */
  key?: string | number | undefined;
  /** The row's position; stored only for lists whose bindings read the index */
  i?: number | undefined;
}

/** Key function for tracking items in repeat. */
type KeyFn<T> = (item: T, index: number) => string | number;

/** Creates the rows of `items[i..end]` in whole batches; returns the index of the first row left. */
export interface BatchRows<T> {
  (
    items: T[],
    i: number,
    end: number,
    put: (managed: ManagedItem<T>, item: T, index: number) => void,
    container: Node,
    anchor: Node,
  ): number;
  /** The update function shared by every row, if any */
  u?: ((managed: ManagedItem<T>, item: T, index: number) => void) | undefined;
}

/**
 * @internal — How a list creates rows in batches: `size` rows are cloned from one fragment (built
 * once from `row`) and bound one by one with `bind`, then inserted together. Compiled code passes
 * it only for lists whose rows need no cleanups, so other apps do not bundle it; the reconciler
 * creates the remainder of a batch, and lists shorter than one batch, with the single-row factory.
 * `update` is one update function shared by every row, given the managed record (which carries
 * the row's guard state) and the new item; rows bound this way have no per-row update closure.
 */
export const __batchRows = <T>(
  size: number,
  row: Node,
  bind: (el: Element, item: T, index: number) => ManagedItem<T>,
  update?: (managed: ManagedItem<T>, item: T, index: number) => void,
): BatchRows<T> => {
  let fragment: Node | undefined;
  const rows: BatchRows<T> = (items, i, end, put, container, anchor) => {
    // Whole batches: one clone and one insert per `size` rows instead of one of each per row.
    while (end - i >= size) {
      if (!fragment) {
        fragment = row.ownerDocument!.createDocumentFragment();
        for (let k = size; k--;) fragment.appendChild(row.cloneNode(true));
      }
      const clone = fragment.cloneNode(true) as ParentNode & Node;
      // The clone holds exactly `size` rows
      for (let el = clone.firstElementChild; el; el = el.nextElementSibling, i++) {
        const item = items[i]!;
        put(bind(el, item, i), item, i);
      }
      container.insertBefore(clone, anchor);
    }
    return i;
  };
  rows.u = update;
  return rows;
};

/** @internal — The cleanups of every row that has none (the rows of lists passed __batchRows): one shared empty array. */
export const __nc: (() => void)[] = [];

// ─────────────────────────────────────────────────────────────
//  createKeyedReconciler — keyed-only, direct-update mode
// ─────────────────────────────────────────────────────────────

export function createKeyedReconciler<T>(
  container: ParentNode & Element,
  anchor: ChildNode,
  createItemFn: (item: T, index: number, refNode: Node) => ManagedItem<T>,
  keyFnOrProp: KeyFn<T> | string,
  batch?: BatchRows<T>,
  trackIndex?: boolean,
) {
  // Resolve key accessor once: string prop → direct access, function → use as-is
  const keyFn: KeyFn<T> =
    typeof keyFnOrProp === 'string' ? (item: T) => (item as any)[keyFnOrProp] as string | number : keyFnOrProp;

  // Rows either carry their own update closure or share the one in `batch.u`.
  const sharedUpdate = batch?.u;
  const updateRow = (managed: ManagedItem<T>, item: T, index: number) => {
    managed.value = item;
    if (trackIndex) managed.i = index;
    if (sharedUpdate) sharedUpdate(managed, item, index);
    else managed.update!(item, index);
  };

  // A list whose bindings read the index (trackIndex) refreshes every row that sits at a new
  // position after a removal or a reorder; the row's guards skip the writes that did not
  // change. Other lists never store a position.
  const syncIndexes = () => {
    for (let i = 0, len = managedItems.length; i < len; i++) {
      const managed = managedItems[i]!;
      if (managed.i !== i) updateRow(managed, managed.value as T, i);
    }
  };

  const managedItems: ManagedItem<T>[] = [];
  // Rows are found by key through a Map that is built the first time an operation needs
  // many lookups and kept in step from then on. Creating rows never pays for it, and the
  // first few lookups (a selection, a swap) scan the rows instead of building it.
  let keyMap: Map<string | number, ManagedItem<T>> | null = null;
  const keys = (): Map<string | number, ManagedItem<T>> => {
    if (keyMap === null) {
      keyMap = new Map();
      for (let i = 0, len = managedItems.length; i < len; i++) keyMap.set(managedItems[i]!.key!, managedItems[i]!);
    }
    return keyMap;
  };
  let scans = 0;
  /** The row for a key; exposed as `get` so compiled code can update the rows it knows changed. */
  const find = (key: string | number): ManagedItem<T> | undefined => {
    if (keyMap !== null) return keyMap.get(key);
    if (++scans > 4) return keys().get(key);
    for (let i = 0, len = managedItems.length; i < len; i++) {
      if (managedItems[i]!.key === key) return managedItems[i];
    }
    return undefined;
  };

  const adopt = (managed: ManagedItem<T>, key: string | number, i: number): ManagedItem<T> => {
    managed.key = key;
    if (trackIndex) managed.i = i;
    if (keyMap !== null) keyMap.set(key, managed);
    return managed;
  };

  const runCleanups = (managed: ManagedItem<T>) => {
    const cleanups = managed.cleanups;
    for (let i = 0, len = cleanups.length; i < len; i++) cleanups[i]!();
  };

  const removeItem = (managed: ManagedItem<T>) => {
    runCleanups(managed);
    managed.el.remove();
  };

  const clearAll = () => {
    const len = managedItems.length;
    if (len === 0) return;
    // Run cleanups (subscriptions, nested reconcilers) before clearing DOM
    for (let i = 0; i < len; i++) runCleanups(managedItems[i]!);
    const anchorParent = anchor.parentNode;
    if (anchorParent) {
      // Empty the container only when it holds nothing but the rows and the anchor
      if (container.childNodes.length === len + 1) {
        anchor.remove();
        (container as HTMLElement).textContent = '';
        container.appendChild(anchor);
      } else {
        for (let i = 0; i < len; i++) managedItems[i]!.el.remove();
      }
    }
    managedItems.length = 0;
    keyMap = null;
  };

  /**
   * Create rows for `items[from..]` and insert them before the anchor. When the list starts
   * empty the container is detached while the rows go in, so the browser does no style work
   * per insertion; when rows already exist it stays attached, because removing and re-adding
   * a large subtree costs more than the incremental inserts it would save.
   */
  const bulkCreate = (items: T[], from = 0) => {
    const end = items.length;
    const count = end - from;
    if (count <= 0) return;

    const base = managedItems.length;
    // Where the container is now, not at creation: later rows change a row's next sibling
    const parent = base === 0 ? container.parentNode : null;
    const next = container.nextSibling;
    if (parent) container.remove();

    managedItems.length = base + count;
    let write = base;
    const put = (managed: ManagedItem<T>, item: T, i: number) =>
      (managedItems[write++] = adopt(managed, keyFn(item, i), i));
    // Whole batches first (a list compiled with __batchRows), then single rows
    let i = batch ? batch(items, from, end, put, container, anchor) : from;

    for (; i < end; i++) {
      const item = items[i]!;
      managedItems[write++] = adopt(createItemFn(item, i, anchor), keyFn(item, i), i);
    }

    if (parent) parent.insertBefore(container, next);
  };

  // Rows are single elements side by side, followed by the list's anchor (a comment). The walk goes
  // node by node, so it ends at the anchor, and a row placed after the last one goes before it
  const applyOrder = (next: ManagedItem<T>[], currentEl: ChildNode | null) => {
    const len = next.length;
    for (let i = 0; i < len; i++) {
      const wanted = next[i]!.el;
      if (wanted === currentEl) currentEl = currentEl.nextSibling;
      else container.insertBefore(wanted, currentEl);
    }
    managedItems.length = len;
    for (let i = 0; i < len; i++) managedItems[i] = next[i]!;
    if (trackIndex) syncIndexes();
  };

  /**
   * Match rows in place, from `from` up to `to`: the new item at i against the row `offset` places
   * further. An identical item needs nothing, one with the row's key is updated at i. Returns the
   * first index whose key differs, or `to`.
   */
  const matchInPlace = (newItems: T[], from: number, to: number, offset: number): number => {
    for (let i = from; i < to; i++) {
      const managed = managedItems[i + offset]!;
      const newItem = newItems[i]!;
      if (managed.value === newItem) continue;
      if (keyFn(newItem, i) !== managed.key) return i;
      updateRow(managed, newItem, i);
    }
    return to;
  };

  const reconcile = (newItems: T[]) => {
    const newLength = newItems?.length ?? 0;
    const oldLength = managedItems.length;

    if (newLength === 0) {
      clearAll();
      return;
    }
    if (oldLength === 0) {
      bulkCreate(newItems);
      return;
    }

    // Fast path: pure append — every existing row keeps its key and position and the new
    // items follow. Without this, appending walks the general path below: a Set of every
    // key, a Map lookup per item and a full reorder pass, to do a run of inserts at the end.
    if (newLength > oldLength) {
      let isAppend = true;
      for (let i = 0; i < oldLength; i++) {
        if (keyFn(newItems[i]!, i) !== managedItems[i]!.key) {
          isAppend = false;
          break;
        }
      }
      if (isAppend) {
        for (let i = 0; i < oldLength; i++) {
          const managed = managedItems[i]!;
          const newItem = newItems[i]!;
          if (managed.value !== newItem) updateRow(managed, newItem, i);
        }
        bulkCreate(newItems, oldLength);
        return;
      }
    }

    // Fast path: single item removed — find missing old key by linear scan. As in the in-place
    // pass below, an identical item needs nothing and a changed one is updated at its new index.
    if (oldLength === newLength + 1) {
      const removedIdx = matchInPlace(newItems, 0, newLength, 0);
      // Every later key must be the next old row's, or this is not one row removed
      if (matchInPlace(newItems, removedIdx, newLength, 1) === newLength) {
        const removedManaged = managedItems[removedIdx]!;
        removeItem(removedManaged);
        if (keyMap !== null) keyMap.delete(removedManaged.key!);
        managedItems.splice(removedIdx, 1);
        if (trackIndex) syncIndexes();
        return;
      }
    }

    if (oldLength === newLength) {
      // Identity-first pass. When keys and order are unchanged, which is every immutable
      // update pattern (`rows.map(...)`, replacing some items in a copied array), each row is
      // matched by position: an identical item needs nothing, an item whose key matches the
      // row at that index is updated in place. Neither derives a key for unchanged rows nor
      // touches the key map. The first position whose key differs means something moved,
      // and the keyed paths below take over from the start (rows already updated here are
      // skipped there because their value now matches).
      if (matchInPlace(newItems, 0, newLength, 0) === newLength) return;

      // Fast path: reorder with same keys (fused allKeysExist + update in single pass)
      let allKeysExist = true;
      let mismatchCount = 0,
        mismatch1 = -1,
        mismatch2 = -1;

      for (let i = 0; i < newLength; i++) {
        const newItem = newItems[i]!;
        const managed = managedItems[i]!;
        // An identical item at the same index is the same row in the same place: no key to
        // derive and no lookup. A swap of two rows in a long list then costs two lookups.
        if (managed.value === newItem) continue;
        const existing = find(keyFn(newItem, i));
        if (!existing) {
          allKeysExist = false;
          break;
        }
        if (existing.value !== newItem) updateRow(existing, newItem, i);
        if (managed !== existing) {
          mismatchCount++;
          if (mismatchCount === 1) mismatch1 = i;
          else if (mismatchCount === 2) mismatch2 = i;
        }
      }

      if (allKeysExist) {
        if (mismatchCount === 0) return;

        if (mismatchCount === 2) {
          const m1 = managedItems[mismatch1]!,
            m2 = managedItems[mismatch2]!;
          const k1 = keyFn(newItems[mismatch1]!, mismatch1),
            k2 = keyFn(newItems[mismatch2]!, mismatch2);
          if (find(k1) === m2 && find(k2) === m1) {
            const el1 = m1.el,
              el2 = m2.el;
            const next1 = el1.nextSibling,
              next2 = el2.nextSibling;
            if (next1 === el2) container.insertBefore(el2, el1);
            else if (next2 === el1) container.insertBefore(el1, el2);
            else {
              container.insertBefore(el2, next1);
              container.insertBefore(el1, next2);
            }
            managedItems[mismatch1] = m2;
            managedItems[mismatch2] = m1;
            if (trackIndex) syncIndexes();
            return;
          }
        }

        const newManagedItems: ManagedItem<T>[] = new Array(newLength);
        const byKey = keys();
        for (let i = 0; i < newLength; i++) newManagedItems[i] = byKey.get(keyFn(newItems[i]!, i))!;
        applyOrder(newManagedItems, managedItems[0]!.el);
        return;
      }

      // Fast path: complete replacement (first and last keys both new)
      const firstNewKey = keyFn(newItems[0]!, 0);
      if (find(firstNewKey) === undefined) {
        const lastNewKey = keyFn(newItems[newLength - 1]!, newLength - 1);
        if (find(lastNewKey) === undefined) {
          clearAll();
          bulkCreate(newItems);
          return;
        }
      }
    }

    // General keyed reconciliation
    const retainedKeys = new Set<string | number>();
    for (let i = 0; i < newLength; i++) retainedKeys.add(keyFn(newItems[i]!, i));

    const kept: ManagedItem<T>[] = [];
    for (let i = 0; i < oldLength; i++) {
      const managed = managedItems[i]!;
      if (retainedKeys.has(managed.key!)) kept.push(managed);
      else {
        removeItem(managed);
        if (keyMap !== null) keyMap.delete(managed.key!);
      }
    }
    managedItems.length = kept.length;
    for (let i = 0; i < kept.length; i++) managedItems[i] = kept[i]!;

    const newManagedItems: ManagedItem<T>[] = [];
    for (let i = 0; i < newLength; i++) {
      const newItem = newItems[i]!;
      const key = keyFn(newItem, i);
      const existing = keys().get(key);
      if (existing) {
        if (existing.value !== newItem) updateRow(existing, newItem, i);
        newManagedItems.push(existing);
      } else {
        const refNode = i < managedItems.length ? managedItems[i]!.el : anchor;
        newManagedItems.push(adopt(createItemFn(newItem, i, refNode), key, i));
      }
    }

    // Every row element is in the container: a when() on a row's root, which replaced it, is THANE008
    applyOrder(newManagedItems, newManagedItems[0]!.el);
  };

  return { reconcile, clearAll, get: find };
}
