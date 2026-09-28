/**
 * Characterisation of `bindConditional` through `__bindIf` / `__bindIfExpr` (F0-2 item 2, before RT-4).
 *
 * The fake DOM is the one in dom-binding.test.ts, copied here (that file is not shared) and
 * extended with an operation log so the order of DOM replacement, nested initialisation and
 * cleanup can be asserted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { __bindIf, __bindIfExpr } from './internal.js';
import { batch, signal } from './signal.js';

/** Every DOM replacement, initialisation and cleanup, in the order they happen. */
let ops: string[] = [];

class FakeElement {
  tagName: string;
  id = '';
  parentNode: FakeElement | null = null;
  children: FakeElement[] = [];
  queries = 0;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
  }

  replaceWith(next: FakeElement): void {
    ops.push(`replace ${this.tagName}#${this.id} -> ${next.tagName}#${next.id}`);
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) {
      next.parentNode = this.parentNode;
      this.parentNode.children[idx] = next;
      this.parentNode = null;
    }
  }

  querySelector(selector: string): FakeElement | null {
    this.queries++;
    if (!selector.startsWith('#')) return null;
    return this.findById(selector.slice(1));
  }

  protected findById(wantedId: string): FakeElement | null {
    if (this.id === wantedId) return this;
    for (const child of this.children) {
      const found = child.findById(wantedId);
      if (found) return found;
    }
    return null;
  }

  cloneDeep(): FakeElement {
    const clone = new FakeElement(this.tagName);
    clone.id = this.id;
    for (const child of this.children) {
      clone.appendChild(child.cloneDeep());
    }
    return clone;
  }
}

class FakeDocumentFragment {
  firstElementChild: FakeElement | null;

  constructor(firstElementChild: FakeElement | null) {
    this.firstElementChild = firstElementChild;
  }

  cloneNode(): FakeDocumentFragment {
    return new FakeDocumentFragment(this.firstElementChild ? this.firstElementChild.cloneDeep() : null);
  }
}

class FakeTemplateElement extends FakeElement {
  private _innerHTML = '';
  content = new FakeDocumentFragment(null);

  constructor() {
    super('template');
  }

  set innerHTML(value: string) {
    this._innerHTML = value;
    this.content = new FakeDocumentFragment(parseSingleRootElement(value));
  }

  get innerHTML(): string {
    return this._innerHTML;
  }
}

const parseSingleRootElement = (html: string): FakeElement => {
  const trimmed = html.trim();
  const match = /^<([a-zA-Z0-9-]+)([^>]*)>/.exec(trimmed);
  const tag = match?.[1] ?? 'div';
  const attrs = match?.[2] ?? '';

  const el = new FakeElement(tag);
  const idMatch = /\sid\s*=\s*["']([^"']+)["']/.exec(attrs);
  if (idMatch?.[1]) {
    el.id = idMatch[1];
  }
  return el;
};

let originalDocument: unknown;
beforeEach(() => {
  ops = [];
  originalDocument = (globalThis as any).document;
  (globalThis as any).document = {
    createElement: (tagName: string) => {
      if (tagName.toLowerCase() === 'template') return new FakeTemplateElement();
      return new FakeElement(tagName);
    },
  };
});
afterEach(() => {
  (globalThis as any).document = originalDocument;
});

const ID = 'c1';
const TEMPLATE = `<div id="${ID}"></div>`;

/** A component root holding the directive's node: a `<template id>` placeholder or the shown element. */
const setup = (initiallyShown: boolean) => {
  const root = new FakeElement('section');
  const node = initiallyShown ? new FakeElement('div') : new FakeTemplateElement();
  node.id = ID;
  root.appendChild(node);
  let inits = 0;
  let cleanups = 0;
  const initNested = (el?: Element) => {
    const n = ++inits;
    const tag = (el as unknown as FakeElement | undefined)?.tagName;
    ops.push(`init ${n} on ${tag}`);
    const cleanup = (suffix: string) => () => {
      ops.push(`cleanup ${n}${suffix}`);
      cleanups++;
    };
    return [cleanup('a'), cleanup('b')];
  };
  const current = () => root.querySelector('#' + ID);
  return { root, node, initNested, current, inits: () => inits, cleanups: () => cleanups };
};

describe('__bindIf: initial state', () => {
  test('hidden placeholder, false condition: nothing is initialised and the DOM is untouched', () => {
    const { root, node, initNested, inits } = setup(false);
    const show = signal(false);
    __bindIf(root as any, show, ID, TEMPLATE, initNested);
    expect(inits()).toBe(0);
    expect(root.children[0]).toBe(node);
    expect(ops).toEqual([]);
  });

  test('hidden placeholder, true condition: the content is created and initialised once while binding', () => {
    const { root, node, initNested, current } = setup(false);
    const show = signal(true);
    __bindIf(root as any, show, ID, TEMPLATE, initNested);
    expect(ops).toEqual([`replace TEMPLATE#${ID} -> DIV#${ID}`, 'init 1 on DIV']);
    expect(current()).not.toBe(node);
    expect(current()?.tagName).toBe('DIV');
  });

  test('shown element, true condition: the existing element is initialised in place, once', () => {
    const { root, node, initNested, current } = setup(true);
    const show = signal(true);
    __bindIf(root as any, show, ID, TEMPLATE, initNested);
    expect(ops).toEqual(['init 1 on DIV']);
    expect(current()).toBe(node);
  });

  test('shown element, false condition: initialised, then hidden and cleaned up while binding', () => {
    const { root, initNested, current } = setup(true);
    const show = signal(false);
    __bindIf(root as any, show, ID, TEMPLATE, initNested);
    expect(ops).toEqual(['init 1 on DIV', `replace DIV#${ID} -> TEMPLATE#${ID}`, 'cleanup 1a', 'cleanup 1b']);
    expect(current()?.tagName).toBe('TEMPLATE');
  });

  test('the condition is the truthiness of the signal value', () => {
    for (const [value, shown] of [
      [0, false],
      ['', false],
      [null, false],
      [undefined, false],
      [NaN, false],
      [1, true],
      ['no', true],
      [{}, true],
      [[], true],
    ] as const) {
      const { root, initNested, current } = setup(false);
      __bindIf(root as any, signal<unknown>(value), ID, TEMPLATE, initNested);
      expect([value, current()?.tagName]).toEqual([value, shown ? 'DIV' : 'TEMPLATE']);
    }
  });
});

describe('__bindIf: toggling', () => {
  test('show → hide → show: a fresh clone each time, initNested once per show, cleanups once per hide', () => {
    const { root, initNested, current, inits, cleanups } = setup(false);
    const show = signal(false);
    __bindIf(root as any, show, ID, TEMPLATE, initNested);

    show(true);
    const first = current();
    show(false);
    const placeholder = current();
    show(true);
    const second = current();

    expect(ops).toEqual([
      `replace TEMPLATE#${ID} -> DIV#${ID}`,
      'init 1 on DIV',
      `replace DIV#${ID} -> TEMPLATE#${ID}`,
      'cleanup 1a',
      'cleanup 1b',
      `replace TEMPLATE#${ID} -> DIV#${ID}`,
      'init 2 on DIV',
    ]);
    expect(inits()).toBe(2);
    expect(cleanups()).toBe(2);
    expect(first?.tagName).toBe('DIV');
    expect(placeholder?.tagName).toBe('TEMPLATE');
    expect(placeholder?.id).toBe(ID);
    expect(second?.tagName).toBe('DIV');
    expect(second).not.toBe(first);
  });

  test('the element handed to initNested is the one placed in the DOM', () => {
    const { root, current } = setup(false);
    const show = signal(false);
    const seen: unknown[] = [];
    __bindIf(root as any, show, ID, TEMPLATE, (el) => {
      seen.push(el);
      return [];
    });
    show(true);
    expect(seen).toEqual([current()]);
  });

  test('a change that keeps the truthiness does nothing', () => {
    const { root, initNested } = setup(false);
    const show = signal<number>(0);
    __bindIf(root as any, show, ID, TEMPLATE, initNested);
    show(1);
    show(2);
    show(3);
    expect(ops).toEqual([`replace TEMPLATE#${ID} -> DIV#${ID}`, 'init 1 on DIV']);
  });

  test('toggled on and back off inside a batch: one notification, no DOM change', () => {
    const { root, node, initNested } = setup(false);
    const show = signal(false);
    __bindIf(root as any, show, ID, TEMPLATE, initNested);
    batch(() => {
      show(true);
      show(false);
    });
    expect(ops).toEqual([]);
    expect(root.children[0]).toBe(node);
  });

  test('the root is searched once, when binding; later toggles work on the tracked node', () => {
    const { root, initNested } = setup(false);
    const show = signal(false);
    __bindIf(root as any, show, ID, TEMPLATE, initNested);
    const queriesAfterBind = root.queries;
    show(true);
    show(false);
    show(true);
    expect(queriesAfterBind).toBe(1);
    expect(root.queries).toBe(1);
  });
});

describe('__bindIf: dispose', () => {
  test('dispose while shown: runs the current cleanups and leaves the content in place', () => {
    const { root, initNested, current } = setup(false);
    const show = signal(true);
    const dispose = __bindIf(root as any, show, ID, TEMPLATE, initNested);
    const shown = current();
    ops = [];
    dispose();
    expect(ops).toEqual(['cleanup 1a', 'cleanup 1b']);
    expect(current()).toBe(shown);

    show(false);
    show(true);
    expect(ops).toEqual(['cleanup 1a', 'cleanup 1b']);
  });

  test('dispose while shown unsubscribes before the cleanups run', () => {
    const { root, current } = setup(false);
    const show = signal(true);
    const dispose = __bindIf(root as any, show, ID, TEMPLATE, () => [() => show(false)]);
    dispose();
    // The cleanup's write reaches no subscriber: the content is not replaced by a placeholder
    expect(current()?.tagName).toBe('DIV');
  });

  test('dispose while hidden: nothing runs, and later changes are ignored', () => {
    const { root, node, initNested } = setup(false);
    const show = signal(false);
    const dispose = __bindIf(root as any, show, ID, TEMPLATE, initNested);
    show(true);
    show(false);
    ops = [];
    dispose();
    expect(ops).toEqual([]);
    show(true);
    expect(ops).toEqual([]);
    expect(root.children[0]?.tagName).toBe('TEMPLATE');
    expect(root.children[0]).not.toBe(node);
  });

  test('a second dispose runs nothing', () => {
    const { root, initNested } = setup(false);
    const show = signal(true);
    const dispose = __bindIf(root as any, show, ID, TEMPLATE, initNested);
    dispose();
    ops = [];
    dispose();
    expect(ops).toEqual([]);
  });
});

describe('__bindIf: where the node comes from', () => {
  test('an anchor element is used instead of searching the root', () => {
    const { root, initNested } = setup(false);
    const container = new FakeElement('li');
    const anchor = new FakeTemplateElement();
    anchor.id = ID;
    container.appendChild(anchor);
    const show = signal(false);
    __bindIf(root as any, show, ID, TEMPLATE, initNested, anchor as any);
    show(true);
    expect(root.queries).toBe(0);
    expect(container.children[0]?.tagName).toBe('DIV');
    // The root's own node with the same id is left alone
    expect(root.children[0]?.tagName).toBe('TEMPLATE');
  });

  test('no node with the id: a no-op dispose, no subscription, no initialisation', () => {
    const root = new FakeElement('section');
    const show = signal(true);
    const subscribe = show.subscribe;
    let subscriptions = 0;
    show.subscribe = (...args) => {
      subscriptions++;
      return subscribe.apply(show, args);
    };
    let inits = 0;
    const dispose = __bindIf(root as any, show, 'missing', TEMPLATE, () => {
      inits++;
      return [];
    });
    show(false);
    show(true);
    dispose();
    expect(inits).toBe(0);
    expect(subscriptions).toBe(0);
  });

  test('the placeholder created on hide carries the id, so a later rebinding finds it', () => {
    const { root, initNested } = setup(true);
    const show = signal(true);
    const dispose = __bindIf(root as any, show, ID, TEMPLATE, initNested);
    show(false);
    dispose();
    ops = [];
    const again = signal(true);
    __bindIf(root as any, again, ID, TEMPLATE, initNested);
    expect(ops).toEqual([`replace TEMPLATE#${ID} -> DIV#${ID}`, 'init 2 on DIV']);
  });
});

describe('__bindIfExpr', () => {
  test('subscribes to every listed signal and re-evaluates the expression on each change', () => {
    const { root, initNested, current } = setup(false);
    const a = signal(1);
    const b = signal(1);
    let evaluations = 0;
    __bindIfExpr(
      root as any,
      [a, b],
      () => {
        evaluations++;
        return a() + b() > 3;
      },
      ID,
      TEMPLATE,
      initNested,
    );
    expect(evaluations).toBe(1);
    a(2);
    expect(current()?.tagName).toBe('TEMPLATE');
    b(2);
    expect(current()?.tagName).toBe('DIV');
    a(0);
    expect(current()?.tagName).toBe('TEMPLATE');
    expect(evaluations).toBe(4);
    expect(ops).toEqual([
      `replace TEMPLATE#${ID} -> DIV#${ID}`,
      'init 1 on DIV',
      `replace DIV#${ID} -> TEMPLATE#${ID}`,
      'cleanup 1a',
      'cleanup 1b',
    ]);
  });

  test('a batch that changes two listed signals evaluates once per notified signal', () => {
    const { root, initNested } = setup(false);
    const a = signal(0);
    const b = signal(0);
    let evaluations = 0;
    __bindIfExpr(
      root as any,
      [a, b],
      () => {
        evaluations++;
        return a() + b() === 2;
      },
      ID,
      TEMPLATE,
      initNested,
    );
    evaluations = 0;
    batch(() => {
      a(1);
      b(1);
    });
    expect(evaluations).toBe(2);
    expect(ops).toEqual([`replace TEMPLATE#${ID} -> DIV#${ID}`, 'init 1 on DIV']);
  });

  test('a signal the expression reads but that is not listed does not trigger an update', () => {
    const { root, initNested, current } = setup(false);
    const listed = signal(0);
    const unlisted = signal(false);
    __bindIfExpr(root as any, [listed], () => unlisted(), ID, TEMPLATE, initNested);
    unlisted(true);
    expect(current()?.tagName).toBe('TEMPLATE');
    listed(1);
    expect(current()?.tagName).toBe('DIV');
  });

  test('the expression result is used for its truthiness', () => {
    const { root, initNested, current } = setup(false);
    const s = signal<unknown>('');
    __bindIfExpr(root as any, [s], () => s() as boolean, ID, TEMPLATE, initNested);
    expect(current()?.tagName).toBe('TEMPLATE');
    s('x');
    expect(current()?.tagName).toBe('DIV');
  });

  test('dispose unsubscribes from every listed signal', () => {
    const { root, initNested } = setup(false);
    const a = signal(false);
    const b = signal(false);
    const dispose = __bindIfExpr(root as any, [a, b], () => a() || b(), ID, TEMPLATE, initNested);
    dispose();
    a(true);
    b(true);
    expect(ops).toEqual([]);
  });
});
