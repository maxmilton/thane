import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { __bindIfExpr } from './internal.js';
import { signal } from './signal.js';

class FakeElement {
  tagName: string;
  id = '';
  parentNode: FakeElement | null = null;
  children: FakeElement[] = [];

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
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) {
      next.parentNode = this.parentNode;
      this.parentNode.children[idx] = next;
      this.parentNode = null;
    }
  }

  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith('#')) return null;
    const wantedId = selector.slice(1);
    return this.findById(wantedId);
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

describe('dom-binding remount semantics', () => {
  test('whenElse remount re-initializes nested bindings and does not reuse stale branch DOM', () => {
    const originalDocument = (globalThis as any).document;
    (globalThis as any).document = {
      createElement: (tagName: string) => {
        if (tagName.toLowerCase() === 'template') return new FakeTemplateElement();
        return new FakeElement(tagName);
      },
    };

    try {
      const root = new FakeElement('div');
      const anchor = new FakeTemplateElement();
      anchor.id = 'cond-1';
      root.appendChild(anchor);

      const show = signal(false);
      let initNestedCount = 0;
      let cleanupCount = 0;

      const dispose = __bindIfExpr(
        root as any,
        [show],
        () => show(),
        'cond-1',
        '<div id="cond-1"></div>',
        () => {
          initNestedCount++;
          return [() => cleanupCount++];
        },
      );

      expect(initNestedCount).toBe(0);
      expect(cleanupCount).toBe(0);
      expect(root.querySelector('#cond-1')?.tagName).toBe('TEMPLATE');

      show(true);
      const firstShownNode = root.querySelector('#cond-1');
      expect(firstShownNode).toBeTruthy();
      expect(firstShownNode?.tagName).toBe('DIV');
      expect(initNestedCount).toBe(1);
      expect(cleanupCount).toBe(0);

      show(false);
      expect(root.querySelector('#cond-1')?.tagName).toBe('TEMPLATE');
      expect(initNestedCount).toBe(1);
      expect(cleanupCount).toBe(1);

      show(true);
      const secondShownNode = root.querySelector('#cond-1');
      expect(secondShownNode).toBeTruthy();
      expect(secondShownNode?.tagName).toBe('DIV');
      expect(secondShownNode).not.toBe(firstShownNode);
      expect(initNestedCount).toBe(2);
      expect(cleanupCount).toBe(1);

      show(false);
      expect(cleanupCount).toBe(2);
      dispose();
      expect(cleanupCount).toBe(2);
    } finally {
      (globalThis as any).document = originalDocument;
    }
  });
});

describe('a branch template with no element', () => {
  // A whenElse() branch that is only text and starts hidden: its template has no element, so showing
  // it replaces the placeholder with `null` (the text "null" in a real DOM) and the binding goes
  // inert. Later toggles must neither throw nor touch the DOM (checked in Chromium on simplify-w0).
  // Runs in a child process because dom-binding.ts caches its parsing <template> in module state,
  // which bun shares between test files.
  test('showing it once leaves the binding inert: later toggles only run the cleanups, without errors', () => {
    const internalUrl = pathToFileURL(join(dirname(import.meta.path), 'internal.ts')).href;
    const signalUrl = pathToFileURL(join(dirname(import.meta.path), 'signal.ts')).href;
    const script = `
      const replaced = [];
      const placeholder = { tagName: 'TEMPLATE', replaceWith: (n) => replaced.push(n) };
      globalThis.document = {
        createElement: (tag) =>
          tag === 'template' ? { innerHTML: '', content: { cloneNode: () => ({ firstElementChild: null }) } } : { tagName: tag.toUpperCase() },
      };
      const errors = [];
      globalThis.queueMicrotask = (cb) => { try { cb(); } catch (e) { errors.push(e.message); } };
      const { __bindIfExpr } = await import(${JSON.stringify(internalUrl)});
      const { signal } = await import(${JSON.stringify(signalUrl)});
      const show = signal(false);
      const inits = [];
      let cleanups = 0;
      const root = { querySelector: () => placeholder };
      const dispose = __bindIfExpr(root, [show], () => show(), 'b1', 'text only', (el) => {
        inits.push(el);
        return [() => cleanups++];
      });
      show(true);
      const afterShow = { replaced: replaced.length, inits: inits.length, cleanups };
      show(false);
      const afterHide = { cleanups };
      show(true);
      show(false);
      show(true);
      dispose();
      console.log(JSON.stringify({ afterShow, afterHide, replaced, inits, cleanups, errors }));
    `;
    const run = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const out = run.stdout.toString().trim().split('\n').at(-1) ?? '';
    expect(JSON.parse(out)).toEqual({
      afterShow: { replaced: 1, inits: 1, cleanups: 0 },
      afterHide: { cleanups: 1 },
      replaced: [null],
      inits: [null],
      cleanups: 1,
      errors: [],
    });
  });
});
