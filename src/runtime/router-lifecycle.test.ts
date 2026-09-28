/**
 * Characterisation of the router's lifecycle, scroll restoration and route context with a fake
 * browser (before RT-10 and RT-11).
 *
 * router.ts has little other unit coverage; the e2e router suite covers it in a
 * browser, but only with `scrollRestoration: true`. These tests pin, as an operation log over a fake
 * `window` / `document`, what `startRouter`, `navigate`, popstate and `stopRouter` do for every
 * shape of the scroll-restoration option (RT-11's `normalizeScrollRestoration`), for every shape
 * of `history.state` (RT-11's `readScrollPositionFromHistoryState`), the globals the router
 * installs, the route-context provider, and Modes B and C of `mount({ router })`.
 *
 * Not pinned on purpose: a scroll state whose `__thaneScroll` is a function. History states are
 * structured clones, which cannot hold functions (RT-11 removes that branch).
 *
 * Every test restores the module state it touched: `teardown()` stops the router with an empty
 * path and title, so `currentPath()` is '' again for router.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { __registerComponentLean, mount } from './component.js';
import { defineRoutes, navigate, navigateBack, startRouter, stopRouter } from './router.js';
import type { Route, RoutesMap } from './router.js';

// ─────────────────────────────────────────────────────────────
//  Fake browser with an operation log
// ─────────────────────────────────────────────────────────────

let log: string[] = [];
let rafs: Array<() => void> = [];
const g = globalThis as any;
const originalCurrentPath = g.currentPath;

class FakeElement {
  private _className = '';
  private _innerHTML = '';
  children = new Map<string, FakeElement>();
  classList = {
    add: (cls: string): void => {
      this._className = this._className ? `${this._className} ${cls}` : cls;
    },
  };
  constructor(public name: string) {}
  get className(): string {
    return this._className;
  }
  set className(v: string) {
    this._className = v;
  }
  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(v: string) {
    log.push(`${this.name}.innerHTML = ${JSON.stringify(v)}`);
    this._innerHTML = v;
  }
  querySelector(sel: string): FakeElement | null {
    return this.children.get(sel) ?? null;
  }
}

interface Browser {
  window: any;
  document: any;
  listeners: Map<string, Array<(e?: any) => void>>;
  setUrl(url: string): void;
}

const fmt = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'number' && Number.isNaN(x) ? 'NaN' : x));

const install = (url: string, state: unknown = null, scroll = { x: 11, y: 22 }): Browser => {
  const location = { href: '', pathname: '', search: '', hash: '' };
  const setUrl = (u: string) => {
    const next = new URL(u, location.href || 'http://app.test/');
    location.href = next.href;
    location.pathname = next.pathname;
    location.search = next.search;
    location.hash = next.hash;
  };
  setUrl(url);
  let scrollRestoration = 'auto';
  const history = {
    state,
    get scrollRestoration() {
      return scrollRestoration;
    },
    set scrollRestoration(v: string) {
      log.push(`history.scrollRestoration = ${v}`);
      scrollRestoration = v;
    },
    pushState(s: unknown, _t: string, u: string) {
      log.push(`pushState ${fmt(s)} ${u}`);
      history.state = structuredClone(s);
      setUrl(u);
    },
    replaceState(s: unknown, _t: string, u: string) {
      log.push(`replaceState ${fmt(s)} ${u}`);
      history.state = structuredClone(s);
      setUrl(u);
    },
    back() {
      log.push('history.back');
    },
  };
  const listeners = new Map<string, Array<(e?: any) => void>>();
  const window = {
    location,
    history,
    scrollX: scroll.x,
    scrollY: scroll.y,
    addEventListener(type: string, fn: (e?: any) => void, opts?: unknown) {
      log.push(`addEventListener ${type}${opts ? ` ${fmt(opts)}` : ''}`);
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: (e?: any) => void) {
      log.push(`removeEventListener ${type}`);
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((f) => f !== fn),
      );
    },
    scrollTo(opts: unknown) {
      log.push(`scrollTo ${fmt(opts)}`);
    },
  };
  const elements = new Map<string, FakeElement>();
  const document = {
    title: 'Doc',
    getElementById: (id: string) => elements.get(id) ?? null,
    elements,
  };
  g.window = window;
  g.document = document;
  g.requestAnimationFrame = (fn: () => void) => {
    rafs.push(fn);
    return rafs.length;
  };
  return { window, document, listeners, setUrl };
};

/** Stops the router with an empty path and title (the state router.test.ts expects) and removes the fakes. */
const teardown = () => {
  if (g.window) {
    g.window.location.pathname = '';
    g.window.location.search = '';
    g.window.location.hash = '';
    g.document.title = '';
    stopRouter();
  }
  delete g.window;
  delete g.document;
  delete g.requestAnimationFrame;
  if (!g.currentPath) g.currentPath = originalCurrentPath;
  rafs = [];
  log = [];
};

afterEach(teardown);

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

const runRafs = () => {
  const pending = rafs;
  rafs = [];
  for (const fn of pending) fn();
};

/** A page component that logs its mount (with the route it received) and its destroy. */
const page = (name: string, seen?: { route?: any }) =>
  ({
    __f: (target: any, _props: unknown, extras?: { route?: any }) => {
      log.push(`mount ${name} into ${target.name}`);
      if (seen) seen.route = extras?.route;
      target.classList.add(name);
      return { root: target, __onDestroy: () => log.push(`destroy ${name}`) };
    },
  }) as any;

const routes = (): { routes: RoutesMap; notFound: Route } => ({
  routes: { '/a': { component: page('A') }, '/b': { component: page('B') } },
  notFound: { component: page('NF') },
});

/** Start at /a, navigate to /b, then go back to /a with the given popstate state. */
const scenario = async (routerConfig: unknown, popState: unknown = null): Promise<string[]> => {
  const b = install('http://app.test/a');
  const outlet = new FakeElement('outlet');
  if (routerConfig === 'none') startRouter(routes(), outlet as any);
  else startRouter(routes(), outlet as any, routerConfig as any);
  await settle();
  log.push('--- navigate /b');
  navigate('/b');
  await settle();
  log.push('--- back to /a');
  b.setUrl('/a');
  b.window.history.state = popState;
  for (const fn of b.listeners.get('popstate') ?? []) fn({ state: popState });
  await settle();
  log.push('--- rafs');
  runRafs();
  log.push('--- stop');
  stopRouter();
  const out = log;
  log = [];
  return out;
};

// ─────────────────────────────────────────────────────────────
//  Scroll-restoration option
// ─────────────────────────────────────────────────────────────

describe('scroll restoration option', () => {
  const enabledDefault = [
    'history.scrollRestoration = manual',
    'replaceState {"__thaneScroll":{"left":11,"top":22}} http://app.test/a',
    'addEventListener scroll {"passive":true}',
    'addEventListener popstate',
    'outlet.innerHTML = ""',
    'mount A into outlet',
    '--- navigate /b',
    'replaceState {"__thaneScroll":{"left":11,"top":22}} http://app.test/a',
    'pushState {"__thaneScroll":{"left":0,"top":0}} /b',
    'destroy A',
    'outlet.innerHTML = ""',
    'outlet.innerHTML = ""',
    'mount B into outlet',
    'scrollTo {"left":0,"top":0,"behavior":"auto"}',
    '--- back to /a',
    'destroy B',
    'outlet.innerHTML = ""',
    'outlet.innerHTML = ""',
    'mount A into outlet',
    'scrollTo {"left":11,"top":22,"behavior":"auto"}',
    '--- rafs',
    'scrollTo {"left":11,"top":22,"behavior":"auto"}',
    '--- stop',
    'destroy A',
    'outlet.innerHTML = ""',
    'outlet.innerHTML = ""',
    'removeEventListener popstate',
    'removeEventListener scroll',
    'history.scrollRestoration = auto',
  ];

  test('no router config, undefined, true and {} all give the enabled defaults', async () => {
    for (const config of ['none', undefined, { scrollRestoration: undefined }, { scrollRestoration: true }, {}]) {
      expect(await scenario(config)).toEqual(enabledDefault);
    }
    expect(await scenario({ scrollRestoration: {} })).toEqual(enabledDefault);
  });

  test('false: nothing is saved, reset or restored, and navigate pushes no scroll state', async () => {
    expect(await scenario({ scrollRestoration: false })).toEqual([
      'addEventListener popstate',
      'outlet.innerHTML = ""',
      'mount A into outlet',
      '--- navigate /b',
      'pushState null /b',
      'destroy A',
      'outlet.innerHTML = ""',
      'outlet.innerHTML = ""',
      'mount B into outlet',
      '--- back to /a',
      'destroy B',
      'outlet.innerHTML = ""',
      'outlet.innerHTML = ""',
      'mount A into outlet',
      '--- rafs',
      '--- stop',
      'destroy A',
      'outlet.innerHTML = ""',
      'outlet.innerHTML = ""',
      'removeEventListener popstate',
    ]);
  });

  test('custom offsets and behaviour are used for the reset and the pushed state', async () => {
    const out = await scenario({ scrollRestoration: { behavior: 'smooth', left: 5, top: 7 } });
    expect(out.filter((l) => l.startsWith('pushState') || l.startsWith('scrollTo'))).toEqual([
      'pushState {"__thaneScroll":{"left":5,"top":7}} /b',
      'scrollTo {"left":5,"top":7,"behavior":"smooth"}',
      'scrollTo {"left":11,"top":22,"behavior":"smooth"}',
      'scrollTo {"left":11,"top":22,"behavior":"smooth"}',
    ]);
  });

  test('explicit zeros and undefined fields keep the defaults', async () => {
    const out = await scenario({ scrollRestoration: { left: 0, top: undefined, behavior: undefined } });
    expect(out).toEqual(enabledDefault);
  });

  test('resetOnNavigate: false keeps the offset on navigate; back/forward still restores', async () => {
    const out = await scenario({ scrollRestoration: { resetOnNavigate: false, left: 3 } });
    expect(out.filter((l) => l.startsWith('pushState') || l.startsWith('scrollTo'))).toEqual([
      'pushState {"__thaneScroll":{"left":3,"top":0}} /b',
      'scrollTo {"left":11,"top":22,"behavior":"auto"}',
      'scrollTo {"left":11,"top":22,"behavior":"auto"}',
    ]);
  });

  test('restoreOnBackForward: false resets on navigate and does nothing on back/forward', async () => {
    const out = await scenario({ scrollRestoration: { restoreOnBackForward: false } });
    expect(out.filter((l) => l.startsWith('pushState') || l.startsWith('scrollTo'))).toEqual([
      'pushState {"__thaneScroll":{"left":0,"top":0}} /b',
      'scrollTo {"left":0,"top":0,"behavior":"auto"}',
    ]);
  });

  test('both flags false: an enabled router that never scrolls', async () => {
    const out = await scenario({ scrollRestoration: { restoreOnBackForward: false, resetOnNavigate: false } });
    expect(out.filter((l) => l.startsWith('scrollTo'))).toEqual([]);
    expect(out).toContain('history.scrollRestoration = manual');
    expect(out).toContain('addEventListener scroll {"passive":true}');
  });

  test('a non-object, non-boolean value counts as enabled with the defaults', async () => {
    expect(await scenario({ scrollRestoration: 1 })).toEqual(enabledDefault);
    expect(await scenario({ scrollRestoration: 'yes' })).toEqual(enabledDefault);
  });

  test('null counts as enabled with the defaults', async () => {
    expect(await scenario({ scrollRestoration: null })).toEqual(enabledDefault);
  });

  test('after stopRouter the defaults apply again', async () => {
    await scenario({ scrollRestoration: { left: 5, top: 7, behavior: 'smooth' } });
    install('http://app.test/a');
    navigate('/z');
    expect(log).toEqual([
      'replaceState {"__thaneScroll":{"left":11,"top":22}} http://app.test/a',
      'pushState {"__thaneScroll":{"left":0,"top":0}} /z',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────
//  history.state shapes
// ─────────────────────────────────────────────────────────────

describe('scroll position read from history.state', () => {
  // Where back/forward to /a scrolls for a popstate carrying the state: {11,22} is the position
  // saved when /a was left, used whenever the state holds no valid position.
  const cases: Array<[string, unknown, string]> = [
    ['null', null, '{"left":11,"top":22}'],
    ['undefined', undefined, '{"left":11,"top":22}'],
    ['a string', 'x', '{"left":11,"top":22}'],
    ['a number', 42, '{"left":11,"top":22}'],
    ['an object without the key', { other: 1 }, '{"left":11,"top":22}'],
    ['key null', { __thaneScroll: null }, '{"left":11,"top":22}'],
    ['key a number', { __thaneScroll: 0 }, '{"left":11,"top":22}'],
    ['key a string', { __thaneScroll: 'x' }, '{"left":11,"top":22}'],
    ['key an array', { __thaneScroll: [1, 2] }, '{"left":11,"top":22}'],
    ['key {}', { __thaneScroll: {} }, '{"left":11,"top":22}'],
    ['left only', { __thaneScroll: { left: 1 } }, '{"left":11,"top":22}'],
    ['left a string', { __thaneScroll: { left: '1', top: 2 } }, '{"left":11,"top":22}'],
    ['top a string', { __thaneScroll: { left: 1, top: '2' } }, '{"left":11,"top":22}'],
    ['numbers', { __thaneScroll: { left: 1, top: 2 } }, '{"left":1,"top":2}'],
    ['numbers and more keys', { __thaneScroll: { left: 1, top: 2, extra: true }, other: 3 }, '{"left":1,"top":2}'],
    ['NaN is a number', { __thaneScroll: { left: Number.NaN, top: 0 } }, '{"left":"NaN","top":0}'],
    ['inherited key', Object.create({ __thaneScroll: { left: 3, top: 4 } }), '{"left":3,"top":4}'],
  ];

  for (const [name, state, target] of cases) {
    test(name, async () => {
      const out = await scenario(undefined, state);
      const afterBack = out.slice(out.indexOf('--- back to /a') + 1, out.indexOf('--- stop'));
      expect(afterBack.filter((l) => l.startsWith('scrollTo'))).toEqual([
        `scrollTo ${target.slice(0, -1)},"behavior":"auto"}`,
        `scrollTo ${target.slice(0, -1)},"behavior":"auto"}`,
      ]);
    });
  }

  test('a popstate event without a state (event undefined) falls back to the saved position', async () => {
    const b = install('http://app.test/a');
    startRouter(routes(), new FakeElement('outlet') as any);
    await settle();
    navigate('/b');
    await settle();
    b.setUrl('/a');
    log = [];
    for (const fn of b.listeners.get('popstate') ?? []) fn(undefined);
    await settle();
    expect(log.filter((l) => l.startsWith('scrollTo'))).toEqual(['scrollTo {"left":11,"top":22,"behavior":"auto"}']);
  });

  test('a valid state at start restores on the initial load (rAF and a 100 ms timer too)', async () => {
    install('http://app.test/a', { __thaneScroll: { left: 7, top: 8 } });
    startRouter(routes(), new FakeElement('outlet') as any);
    await settle();
    expect(log.filter((l) => l.startsWith('scrollTo'))).toEqual(['scrollTo {"left":7,"top":8,"behavior":"auto"}']);
    runRafs();
    await new Promise((r) => setTimeout(r, 120));
    expect(log.filter((l) => l.startsWith('scrollTo'))).toEqual([
      'scrollTo {"left":7,"top":8,"behavior":"auto"}',
      'scrollTo {"left":7,"top":8,"behavior":"auto"}',
      'scrollTo {"left":7,"top":8,"behavior":"auto"}',
    ]);
  });

  test('an invalid state at start is an ordinary initial load (no scroll)', async () => {
    install('http://app.test/a', { __thaneScroll: { left: 'x', top: 8 } });
    startRouter(routes(), new FakeElement('outlet') as any);
    await settle();
    runRafs();
    expect(log.filter((l) => l.startsWith('scrollTo'))).toEqual([]);
  });

  test('the state written at start keeps the other keys of history.state', async () => {
    install('http://app.test/a?q=1#h', { app: 'x' });
    startRouter(routes(), new FakeElement('outlet') as any);
    expect(log[1]).toBe('replaceState {"app":"x","__thaneScroll":{"left":11,"top":22}} http://app.test/a?q=1#h');
  });
});

// ─────────────────────────────────────────────────────────────
//  Lifecycle and globals
// ─────────────────────────────────────────────────────────────

describe('router lifecycle', () => {
  test('startRouter installs navigate, navigateBack and currentPath; stopRouter removes the first two', async () => {
    install('http://app.test/a');
    startRouter(routes(), new FakeElement('outlet') as any);
    expect(g.navigate).toBe(navigate);
    expect(g.navigateBack).toBe(navigateBack);
    expect(g.currentPath).toBe(originalCurrentPath);
    await settle();
    expect(g.currentPath()).toBe('/a');
    stopRouter();
    expect('navigate' in g).toBe(false);
    expect('navigateBack' in g).toBe(false);
    expect(g.currentPath).toBe(originalCurrentPath);
  });

  test('startRouter puts currentPath back when it was deleted', () => {
    delete g.currentPath;
    install('http://app.test/a');
    startRouter(routes(), new FakeElement('outlet') as any);
    expect(g.currentPath).toBe(originalCurrentPath);
  });

  test('a second startRouter warns and changes nothing', async () => {
    install('http://app.test/a');
    startRouter(routes(), new FakeElement('outlet') as any);
    await settle();
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      log = [];
      startRouter(routes(), new FakeElement('other') as any, { scrollRestoration: false });
    } finally {
      console.warn = warn;
    }
    expect(warnings).toEqual(['[thane-router] Router already started — only one instance is allowed.']);
    expect(log).toEqual([]);
  });

  test('stopRouter when not started does nothing', () => {
    install('http://app.test/a');
    stopRouter();
    expect(log).toEqual([]);
  });

  test('stopRouter resets currentPath to the location', async () => {
    const b = install('http://app.test/a');
    startRouter(routes(), new FakeElement('outlet') as any);
    await settle();
    b.setUrl('/elsewhere');
    stopRouter();
    expect(g.currentPath()).toBe('/elsewhere');
  });

  test('navigateBack calls history.back', () => {
    install('http://app.test/a');
    navigateBack();
    expect(log).toEqual(['history.back']);
  });

  test('navigate to the current URL does nothing', async () => {
    install('http://app.test/a?q=1#h');
    startRouter(routes(), new FakeElement('outlet') as any, { scrollRestoration: false });
    await settle();
    log = [];
    navigate('/a?q=1#h');
    expect(log).toEqual([]);
  });

  test('a scroll event schedules one save per frame', async () => {
    const b = install('http://app.test/a');
    startRouter(routes(), new FakeElement('outlet') as any);
    await settle();
    log = [];
    for (const fn of b.listeners.get('scroll') ?? []) fn();
    for (const fn of b.listeners.get('scroll') ?? []) fn();
    expect(rafs.length).toBe(1);
    b.window.scrollY = 99;
    runRafs();
    expect(log).toEqual(['replaceState {"__thaneScroll":{"left":11,"top":99}} http://app.test/a']);
  });
});

// ─────────────────────────────────────────────────────────────
//  Route context
// ─────────────────────────────────────────────────────────────

describe('route context', () => {
  test('a routed page receives the route: params, path, pattern, query, hash, title, state', async () => {
    const seen: { route?: any } = {};
    install('http://app.test/users/42?x=1#h', { k: 1 });
    startRouter(
      { routes: { '/users/:id': { component: page('U', seen), title: 'User' } }, notFound: { component: page('NF') } },
      new FakeElement('outlet') as any,
      { scrollRestoration: false },
    );
    await settle();
    const r = seen.route;
    expect(Object.keys(r)).toEqual(['params', 'path', 'pattern', 'searchParams', 'hash', 'title', 'state']);
    expect(r.params).toEqual({ id: '42' });
    expect(r.path).toBe('/users/42');
    expect(r.pattern).toBe('/users/:id');
    expect(r.searchParams.toString()).toBe('x=1');
    expect(r.hash).toBe('#h');
    expect(r.title).toBe('User');
    expect(r.state).toEqual({ k: 1 });
    expect(g.document.title).toBe('User');
  });

  test('a route without a title reports the document title and leaves it alone', async () => {
    const seen: { route?: any } = {};
    install('http://app.test/a');
    startRouter(
      { routes: { '/a': { component: page('A', seen) } }, notFound: { component: page('NF') } },
      new FakeElement('outlet') as any,
      { scrollRestoration: false },
    );
    await settle();
    expect(seen.route.title).toBe('Doc');
    expect(g.document.title).toBe('Doc');
  });

  test('the notFound route has pattern "notFound"', async () => {
    const seen: { route?: any } = {};
    install('http://app.test/nope');
    startRouter(
      { routes: { '/a': { component: page('A') } }, notFound: { component: page('NF', seen), title: '404' } },
      new FakeElement('outlet') as any,
      { scrollRestoration: false },
    );
    await settle();
    expect(seen.route.pattern).toBe('notFound');
    expect(seen.route.title).toBe('404');
    expect(seen.route.params).toEqual({});
  });

  test('a lazy route: the default export is mounted', async () => {
    install('http://app.test/a');
    startRouter(
      {
        routes: { '/a': { component: () => Promise.resolve({ default: page('LazyA') }) } },
        notFound: { component: page('NF') },
      },
      new FakeElement('outlet') as any,
      { scrollRestoration: false },
    );
    await settle();
    expect(log).toContain('mount LazyA into outlet');
  });

  /** A component created outside the router gets its route from the provider the router installs. */
  const providerRoute = (): any => {
    const seen: { ctx?: any } = {};
    const tpl = { content: { cloneNode: () => ({ querySelectorAll: () => [] }) } } as any;
    const ref = __registerComponentLean(
      'ctx-probe',
      (ctx: any) => {
        seen.ctx = ctx;
        return {};
      },
      tpl,
    );
    ref.__f({ classList: { add() {} }, append() {} } as any);
    return seen.ctx.route;
  };

  test('provider, with a window: the live location, the loaded route pattern and title', async () => {
    install('http://app.test/users/7?y=2#k', { s: 1 });
    startRouter(
      { routes: { '/users/:id': { component: page('U'), title: 'User' } }, notFound: { component: page('NF') } },
      new FakeElement('outlet') as any,
      { scrollRestoration: false },
    );
    await settle();
    const r = providerRoute();
    expect(r.params).toEqual({ id: '7' });
    expect(r.path).toBe('/users/7');
    expect(r.pattern).toBe('/users/:id');
    expect(r.searchParams.toString()).toBe('y=2');
    expect(r.hash).toBe('#k');
    expect(r.title).toBe('User');
    expect(r.state).toEqual({ s: 1 });
  });

  test('provider, without a window: currentPath, empty query and hash, no state', () => {
    const r = providerRoute();
    expect(r.params).toEqual({});
    expect(r.path).toBe('');
    expect(r.pattern).toBe('');
    expect(r.searchParams.toString()).toBe('');
    expect(r.hash).toBe('');
    expect(r.title).toBe('');
    expect(r.state).toBeUndefined();
  });

  test('no match and no notFound route: pattern is the path, title the document title, outlet empty', async () => {
    install('http://app.test/x');
    startRouter({ routes: {}, notFound: undefined as any }, new FakeElement('outlet') as any, {
      scrollRestoration: false,
    });
    await settle();
    expect(log).toEqual(['addEventListener popstate', 'outlet.innerHTML = ""']);
    const r = providerRoute();
    expect(r.pattern).toBe('/x');
    expect(r.title).toBe('Doc');
  });
});

// ─────────────────────────────────────────────────────────────
//  mount({ router }): Modes B and C
// ─────────────────────────────────────────────────────────────

describe('mount({ router })', () => {
  const table = () =>
    defineRoutes({
      '/a': { component: page('A') },
      'notFound': { component: page('NF') },
    });

  test('Mode C: pages render into the target; destroy stops the router', async () => {
    install('http://app.test/a');
    const target = new FakeElement('body');
    const handle = mount({ router: { routes: table(), scrollRestoration: false }, target: target as any });
    expect(handle.root).toBe(target as any);
    await settle();
    expect(log).toEqual(['addEventListener popstate', 'body.innerHTML = ""', 'mount A into body']);
    log = [];
    expect(handle.destroy()).toBeUndefined();
    expect(log).toEqual(['destroy A', 'body.innerHTML = ""', 'body.innerHTML = ""', 'removeEventListener popstate']);
    expect('navigate' in g).toBe(false);
  });

  const shell = (outletId: string | null) =>
    ({
      __f: (target: any) => {
        log.push(`mount Shell into ${target.name}`);
        if (outletId) target.children.set(`#${outletId}`, new FakeElement(outletId));
        return { root: target, __onDestroy: () => log.push('destroy Shell') };
      },
    }) as any;

  test('Mode B: the shell is mounted, pages go into #router-outlet; destroy stops the router, then the shell', async () => {
    install('http://app.test/a');
    const target = new FakeElement('body');
    const handle = mount({
      component: shell('router-outlet'),
      router: { routes: table(), scrollRestoration: false },
      target: target as any,
    });
    expect(handle.root).toBe(target as any);
    await settle();
    expect(log).toEqual([
      'mount Shell into body',
      'addEventListener popstate',
      'router-outlet.innerHTML = ""',
      'mount A into router-outlet',
    ]);
    log = [];
    handle.destroy();
    expect(log).toEqual([
      'destroy A',
      'router-outlet.innerHTML = ""',
      'router-outlet.innerHTML = ""',
      'removeEventListener popstate',
      'destroy Shell',
      'body.innerHTML = ""',
    ]);
  });

  test('Mode B: a custom outlet id, found through document.getElementById when the shell does not hold it', async () => {
    const b = install('http://app.test/a');
    const outside = new FakeElement('router-main');
    b.document.elements.set('router-main', outside);
    mount({
      component: shell(null),
      router: { routes: table(), outletId: 'router-main', scrollRestoration: false },
      target: new FakeElement('body') as any,
    });
    await settle();
    expect(log).toContain('mount A into router-main');
  });

  test('Mode B without an outlet throws, and the shell goes again', () => {
    install('http://app.test/a');
    expect(() =>
      mount({
        component: shell(null),
        router: { routes: table(), scrollRestoration: false },
        target: new FakeElement('body') as any,
      }),
    ).toThrow(
      '[thane] Router outlet element with id="router-outlet" not found. ' +
        "In Mode B (shell + router), your shell component's template must contain " +
        'an element with id="router-outlet".',
    );
    expect(log).toEqual(['mount Shell into body', 'destroy Shell', 'body.innerHTML = ""']);
  });
});
