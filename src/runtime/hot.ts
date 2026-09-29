/**
 * Hot swapping for a page the development server serves (`thane dev`). The server's page script sets
 * `globalThis.__thaneHot` before the app loads, and every component registered while it is set is
 * registered here too, by its selector. When a component file changes, the server sends the file,
 * compiled; it runs in the page, its components register again, and each live instance of one is
 * mounted again with the new code, into its own host with its own props. The rest of the page keeps
 * its state. A built app never sets the flag, and a production build leaves all of this out.
 * @internal
 */

/** A component's factory, as `__registerComponent` returns it */
interface Factory {
  __f: (target: HTMLElement, props?: any, extras?: any) => Instance;
}

/** A mounted component, as its parent (or a mount handle) holds it to destroy it */
interface Instance {
  root: HTMLElement;
  __bindingsCleanup?: (() => void) | undefined;
  __onDestroy?: (() => void) | undefined;
}

/** A live instance: where it is mounted, and the cleanups of the code it runs now */
interface Live {
  target: HTMLElement;
  props: any;
  extras: any;
  instance: Instance;
  bindings?: (() => void) | undefined;
  destroy?: (() => void) | undefined;
}

/** A selector's newest factory, the handle every file holds, and its live instances */
interface Entry {
  current: Factory;
  handle: Factory;
  live: Set<Live>;
}

/** The page's hot state, `globalThis.__thaneHot` */
export interface HotRuntime {
  components?: Map<string, Entry>;
  sheets?: Map<string, CSSStyleSheet>;
}

/** The hot state of a page the development server serves, or undefined */
export const hotRuntime = (): HotRuntime | undefined => (globalThis as { __thaneHot?: HotRuntime }).__thaneHot;

/**
 * The instance's cleanups become the ones of the code it runs now. Its parent destroys the instance
 * object it holds, so the object stays and its cleanups are replaced; running one forgets the instance.
 */
const adopt = (entry: Entry, live: Live, fresh: Instance): void => {
  live.bindings = fresh.__bindingsCleanup;
  live.destroy = fresh.__onDestroy;
  live.instance.__bindingsCleanup = () => {
    entry.live.delete(live);
    live.bindings?.();
  };
  live.instance.__onDestroy = () => {
    entry.live.delete(live);
    live.destroy?.();
  };
};

/**
 * Register a component: the first registration of a selector returns a handle that mounts the newest
 * code and keeps track of each instance; a later one (the same file, changed) makes its factory the
 * newest and mounts every live instance again with it.
 */
export const hotRegister = (hot: HotRuntime, selector: string, factory: Factory): Factory => {
  const components = (hot.components ??= new Map());
  const existing = components.get(selector);
  if (!existing) {
    const entry: Entry = {
      current: factory,
      live: new Set(),
      handle: {
        __f: (target, props, extras) => {
          const fresh = entry.current.__f(target, props, extras);
          const live: Live = { target, props, extras, instance: { root: fresh.root } };
          entry.live.add(live);
          adopt(entry, live, fresh);
          return live.instance;
        },
      },
    };
    components.set(selector, entry);
    return entry.handle;
  }
  existing.current = factory;
  for (const live of [...existing.live]) {
    // An instance whose host left the page without being destroyed is forgotten
    if (!live.target.isConnected) {
      existing.live.delete(live);
      continue;
    }
    live.bindings?.();
    live.destroy?.();
    live.target.innerHTML = '';
    adopt(existing, live, factory.__f(live.target, live.props, live.extras));
  }
  return existing.handle;
};

/** A selector's stylesheet: added once, and replaced when the component's file changes */
export const hotStyles = (hot: HotRuntime, selector: string, scopedCss: string): void => {
  const sheets = (hot.sheets ??= new Map());
  let sheet = sheets.get(selector);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheets.set(selector, sheet);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
  sheet.replaceSync(scopedCss);
};
