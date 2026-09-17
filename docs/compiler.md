# Compiler

Thane's compiler is an esbuild-based plugin pipeline that transforms your TypeScript components into optimized vanilla JavaScript at build time. This page explains how the compilation process works.

## Build Pipeline

The compiler runs as a series of esbuild plugins, each handling a specific transformation:

```
Source (.ts)
  │
  ├─ 1. Thane Linter           → Static analysis, 12 lint rules (THANE400-411)
  ├─ 2. Component Precompiler  → CTFE: evaluates component setup at build time
  ├─ 3. Reactive Binding Compiler → html`` → static <template> + __b() bindings
  ├─ 4. Routes Precompiler     → Processes defineRoutes() calls
  ├─ 5. Router Typegen         → Generates .d.ts for type-safe routing
  ├─ 6. Global CSS Bundler     → .css imports → string exports
  ├─ 7. Minification           → Plans selector renames from the sources (prod)
  ├─ 8. TSC Type Checker       → TypeScript checking (errors/warnings)
  ├─ 9. HTML Bootstrap Injector → Injects entry script into index.html
  └─ 10. Post-Build Processor  → gzip/brotli, metafile output
  │
  ▼
Output (dist/)
```

## Template Compilation

The core transformation is converting `html` tagged templates into static DOM templates plus direct binding code.

### Input

```typescript
export const Counter = defineComponent(() => {
  const count = signal(0);
  const inc = () => count(count() + 1);

  return {
    template: html` <button @click=${inc}> Clicks: ${count()} </button> `,
  };
});
```

### Output (conceptual)

```javascript
// 1. Static template element — created once, cloned for each instance
const _t = document.createElement('template');
_t.innerHTML = `<button>Clicks: <!--b0-->0<!----></button>`;

// 2. Component registration with binding function
__registerComponent(
  'counter',
  (ctx) => {
    const count = signal(0);
    const inc = () => count(count() + 1);

    return {
      __b: (ctx) => {
        // TreeWalker finds comment markers
        const markers = _findCommentMarkers(ctx.root);

        // Direct event binding
        markers['btn0'].addEventListener('click', inc);

        // Signal subscription — updates only the text node
        const unsub = count.subscribe((v) => {
          markers['b0'].nextSibling.data = v;
        }, true);

        return () => {
          unsub();
        };
      },
    };
  },
  _t,
);
```

Key points:

- The HTML string becomes a static `<template>` that is cloned (not parsed) for each component instance.
- Comment markers (`<!--b0-->`) identify binding sites.
- The `__b()` function uses `TreeWalker` to find markers in a single DOM pass.
- Each signal gets a direct subscription to the exact DOM node it affects — no diffing.

## Binding Kinds

The compiler detects and generates different binding types from the contracts:

| Kind        | Source syntax       | Generated code                                     |
| :---------- | :------------------ | :------------------------------------------------- |
| Text        | `${signal()}`       | `signal.subscribe(v => textNode.data = v)`         |
| Attribute   | `:attr=${value}`    | `signal.subscribe(v => el.setAttribute(attr, v))`  |
| Style       | `style=${expr}`     | `signal.subscribe(v => el.style.cssText = v)`      |
| Event       | `@click=${handler}` | `el.addEventListener('click', handler)`            |
| Conditional | `${when(cond())}`   | `__bindIf(root, signal, id, template, initNested)` |
| IfElse      | `${whenElse(...)}`  | `__bindIfExpr(root, signals, evalExpr, ...)`       |
| Repeat      | `${repeat(...)}`    | `createKeyedReconciler(container, anchor, ...)`    |

## Component Registration

The compiler emits one of three registration functions depending on what the component uses:

| Function                  | When emitted                                                 |
| :------------------------ | :----------------------------------------------------------- |
| `__registerComponent`     | Component has styles, lifecycle hooks, or extra templates    |
| `__registerComponentLean` | No styles, no lifecycle hooks — minimal overhead             |
| `defineComponent`         | Preserved for uncompiled contexts (tests, dev mode fallback) |

The lean variant (`__registerComponentLean`) tree-shakes the entire style subsystem when no component in the app uses `styles`.

## CTFE — Compile-Time Function Evaluation

The **Component Precompiler** evaluates the component setup function at build time in a sandboxed context. This enables:

- Static analysis of which signals are read in the template
- Detection of which bindings can be optimized
- Extraction of the template string before runtime

## CSS Processing

### Scoped Styles

The `styles` property is processed by `scopeCssRules()` at runtime. Every selector is prefixed with the component's class selector:

```css
/* Input */
.card {
  padding: 1rem;
}
.card h1 {
  color: blue;
}

/* Output (for component selector 'my-card') */
.my-card .card {
  padding: 1rem;
}
.my-card .card h1 {
  color: blue;
}
```

### CSS File Imports

The **Global CSS Bundler** plugin transforms `.css` file imports into string exports:

```typescript
// Input
import styles from './Card.module.css';

// Output
const styles = '/* contents of Card.module.css */';
```

## Production Minification

A production build minifies three kinds of text, each by the tool that knows its language:

| What                                          | Minified by  | Where                                   |
| --------------------------------------------- | ------------ | --------------------------------------- |
| JavaScript, yours and every library's         | esbuild      | while bundling                          |
| HTML templates                                | the compiler | where it emits a compiled template      |
| Stylesheets (`css` templates, `.css` imports) | the compiler | where it reads the template or the file |

**Thane never edits emitted JavaScript.** The output files are not read back, searched or patched, so nothing Thane does can change a library, whatever the library contains and however the bundle is split. A template or stylesheet is minified at the one point where the compiler holds it as HTML or CSS, not recognised afterwards by what a string looks like.

In a `css` template the substitutions are located by the TypeScript parser and carried over untouched, and the literal text keeps its escape sequences exactly as written (`content: "\\201C"`). In a template, `<pre>` and `<textarea>` content is carried through as written; the same holds for inline `<script>` and `<style>` in `index.html`.

### Selector minification

Component selectors are replaced with shorter names (e.g., `product-card` → `a-b`). The **Minification** plugin decides which before anything is compiled: it reads the project's own TypeScript, stylesheets and `index.html` and renames a selector only when every appearance of its text is a place the compiler writes itself (see [Styling](styling.md#selector-minification)). The compiler then writes the short name where it writes a selector: the registration, the host element of a child component, the root tag in `index.html`, and `.product-card` class selectors in component stylesheets.

## HTML Bootstrap Injection

The **HTML Bootstrap Injector** modifies your `index.html` to include the compiled entry point script tag. You don't need to manually add `<script>` tags.

## Route Type Generation

The **Router Typegen** plugin:

1. Scans `defineRoutes()` calls to extract route patterns
2. Generates `.d.ts` files in `.thane/types/router/`
3. These types make `navigate()` autocomplete valid paths and `route.params` type-safe per page

Run `thane types` to regenerate types manually, or they update automatically during `thane dev` and `thane build`.

## Tree-Shaking

The compiler is designed for aggressive tree-shaking:

- Router code is eliminated if `defineRoutes` is never imported
- The style subsystem is eliminated if no component uses `styles`
- `registerGlobalStyles` is eliminated if never imported
- Lifecycle hooks are optimized away when absent

This is why the runtime stays at ~3 KB gzip for minimal applications.

← [Back to Docs](README.md)
