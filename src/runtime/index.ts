/** Runtime entry point. */

// Global type declarations for template tags and directives
declare global {
  /**
   * Tagged template for HTML content
   */
  function html(strings: TemplateStringsArray, ...values: any[]): any;

  /**
   * Tagged template for CSS content
   */
  function css(strings: TemplateStringsArray, ...values: any[]): any;

  /**
   * Conditional directive - shows content when condition is truthy
   */
  function when(condition: boolean | (() => boolean)): string;

  /**
   * Conditional directive with else branch
   */
  function whenElse<T, F>(condition: boolean | (() => boolean), thenTemplate: T, elseTemplate: F): T | F;

  /**
   * Repeat directive for rendering arrays
   * @param emptyTemplate shown while the list is empty: an html template, or null; the key function goes fourth
   */
  function repeat<T>(
    items: T[] | (() => T[]),
    templateFn: (item: T, index: number) => any,
    emptyTemplate?: string | null,
    trackBy?: (item: T, index: number) => string | number,
  ): any[];

  /**
   * Navigate to a path (router).
   * Type-safe once Thane has generated the route types (any `thane` command does).
   */
  function navigate(path: import('./router.js').RoutePaths): void;

  /**
   * Navigate back in history (router).
   */
  function navigateBack(): void;

  /**
   * The active router path as a read-only signal.
   * Available globally when the router is used.
   */
  const currentPath: import('./types.js').ReadonlySignal<string>;
}

// The public API: what an app calls, and the types an app writes in its own code. Every other
// type stays in the module declarations, so hovers and inference still show it. Compiler helpers
// are in ./internal.ts ('thane/runtime'), the router values in ./router-exports.ts ('thane/router').
export type { Signal, ReadonlySignal } from './types.js';
export { signal, batch, computed, effect, untrack } from './signal.js';
export {
  defineComponent,
  registerGlobalStyles,
  mount,
  unmount,
  type ComponentContext,
  type ComponentHTMLSelector,
  type MountHandle,
} from './component.js';
export type { RoutePaths } from './router.js';
