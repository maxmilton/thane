# Known Limitations

This page documents current constraints, browser requirements, and by-design decisions in Thane.

## Compiler Constraints

### One Component Per File

Only one `defineComponent()` call is allowed per file (THANE407). The compiler processes the entire file as a single component unit — multiple calls cause silent skipping.

### No Nested `html` Tags

`html` tagged templates cannot be nested inside other `html` templates (THANE404). Inner templates must be extracted to `const` variables:

```typescript
// ❌ Not allowed
template: html`<div>${html`<span>nested</span>`}</div>`;

// ✅ Allowed
const inner = html`<span>nested</span>`;
template: html`<div>${inner}</div>`;
```

Templates inside directive callbacks (`repeat`, `whenElse`) are the exception — these are processed independently.

### Template Variables Must Be Local

`html` template variables used inside `defineComponent()` must be defined in the same file (THANE410). The compiler resolves templates via AST analysis and cannot process imported variables. CSS imports are unaffected.

### Unique Component Names

The compiler recognises a child component call, `${Card({ … })}`, by the component's export name, over every component in the working directory and the project. Two components exported under the same name collide: the last one found wins, and its selector names the host element of both. A function called in a template with the name of a component defined elsewhere is taken for that component too. Give every component a unique export name.

A component file added while `thane dev` is running is recognised as a child component only after `thane dev` is restarted.

### One Return Object per Setup

A setup function returns one object (THANE412). The compiler builds one static template per component, so an early `return { template: … }` in a branch cannot work. Use `when()` or `whenElse()` in the template instead.

### `const` Required for Components and Templates

- Components must be declared with `const` (THANE408)
- `html` and `css` tagged templates must be assigned to `const` (THANE403)
- Components must use named exports, never default exports (THANE400)

### No Conditional Template Initialization

Template variables cannot use ternary or logical operators (THANE405). Use `whenElse()` for conditional rendering instead.

### User IDs

Your `id` attributes are kept on every element, bound or not. The compiler adds no ids of its own and never uses one to find an element. Inside `repeat()` rows an `id` is repeated on every row, so prefer `data-*` attributes there.

A comment written like one of the compiler's own markers (`<!--b0-->`) is reported as THANE009 when the compiler uses that name in the same template; change or remove it.

### One Root Element per Repeat Row

Every `repeat()` row is cloned from one element and moved, updated and removed by that element, so a row template must have exactly one root element. A row such as `(item) => html\`<dt>${item.term}</dt><dd>${item.def}</dd>\`` is reported at build time as THANE007; wrap the pair in a single element instead. A row that is only a directive (a `when()`, `whenElse()` or nested `repeat()`) is THANE007 as well. A row that is a child component call, `(item) => Card({ item })`, has no markup of its own and is not affected.

For the same reason a row's root element cannot carry `when()` (THANE008): filter the list, or put the `when()` on an element inside the row.

Inside the row, anything a component template can hold works, at any depth: bindings, event handlers, child components, `when()`, `whenElse()` and further lists.

### Empty Templates Are Static

The empty template of a `repeat()`, its third argument, is inserted as written, as one element: it holds no bindings or event handlers. An empty template with a `${…}`, more than one root, or text outside an element is a build error (THANE011). For an empty state that changes, put a `when()` next to the list.

### Whitespace Between Elements

Whitespace-only text between two elements is removed from compiled templates, so `<b>x</b> <i>y</i>` renders as "xy", where a browser would show "x y". Put the space inside one of the elements (`<b>x </b><i>y</i>`) or write it as `&#32;`. Whitespace next to a text binding is kept; see [Templates](templates.md#whitespace).

## Runtime Constraints

### Light DOM Only

Thane uses Light DOM exclusively — no Shadow DOM. This means:

- Parent styles **cascade into** child components
- Standard CSS specificity rules apply across component boundaries
- Style isolation depends on auto-scoped CSS class selectors, not shadow boundaries

### CSS Nesting Required

Scoped styles depend on native CSS Nesting (the `&` selector). This sets the minimum browser versions:

| Chrome | Firefox | Safari | Edge |
| :----: | :-----: | :----: | :--: |
|  120+  |  117+   | 17.2+  | 120+ |

Older browsers will not render scoped styles correctly.

### Modern Browsers Only

Thane targets modern browsers and uses APIs without polyfills:

- `adoptedStyleSheets` for style management
- `CSSStyleSheet.replaceSync()` for style injection
- `queueMicrotask` for async error surfacing
- `HTMLTemplateElement` for template cloning
- CSS Nesting for scoped styles

### No Async Component Setup

The `defineComponent()` setup function must be synchronous. It cannot be `async` and cannot `await` promises. Data fetching and other async work should go in `onMount`:

```typescript
// ❌ Not allowed
export const Page = defineComponent(async () => {
  const data = await fetch('/api/data');
  ...
});

// ✅ Correct pattern
export const Page = defineComponent(() => {
  const data = signal(null);

  return {
    template: html`<div>${data()}</div>`,
    onMount: () => {
      fetch('/api/data')
        .then(res => res.json())
        .then(d => data(d));
    },
  };
});
```

### Single Router Instance

Only one router instance is supported. Calling `mount()` with a `router` option a second time logs a warning and is ignored.

### Circular Signal Dependencies

Cycles are not detected. When subscribers keep setting each other's signals, every round of the cascade runs one level deeper, so a cycle that never settles ends in a stack overflow (`RangeError: Maximum call stack size exceeded`), and afterwards later writes may never be notified. A cascade that settles runs to the end, but a very long one can overflow the stack as well. See [Signals](signals.md#circular-dependencies).

### Stale `computed` Reads in a Batch or a Cascade

A `computed` is marked dirty when one of its sources notifies it, and re-evaluates on its next read; until then a read returns the previous value. Inside a `batch()` function, and while subscribers run, those notifications can still be waiting: a read in the batch function, in a subscriber that has just set one of the computed's sources, or of a `computed` built on other `computed`s in a subscriber of their source, returns the old value. Read the computed after the batch, or read the source signals directly there. See [Signals](signals.md#computed-signals).

## Missing Features

These features are **not currently supported**:

| Feature                           | Status                                                      |
| :-------------------------------- | :---------------------------------------------------------- |
| Shadow DOM                        | By design — Light DOM only                                  |
| SSR / Server-Side Rendering       | Not supported                                               |
| `ref` API (direct element access) | Not available — use `ctx.root.querySelector()` in `onMount` |
| Context / Provide / Inject        | Not available — use module-level signals for shared state   |
| Async component setup             | Not supported — use `onMount` for async work                |
| Multiple router instances         | Not supported — single-instance only                        |
| Route guards / middleware         | Not built-in                                                |
| Animated route transitions        | Not built-in                                                |

## Production Build Behavior

### `console.*` Stripping

Production builds (`thane build --prod`) strip all `console.*` calls by default. Override with `--no-drop-console` if needed.

### `debugger` Stripping

Production builds strip `debugger` statements by default. Override with `--no-drop-debugger`.

### Source Maps

Source maps are **disabled** in production builds by default. Enable with `--sourcemap`.

## Dev Server Requirement

The `thane dev` command requires the **Bun** runtime. Running it with Node.js produces an error:

```
Error: Thane CLI requires the Bun runtime.
```

Install Bun from [bun.sh](https://bun.sh).

## Router Constraints

### No Root-Level Parameters

Route patterns starting with `/:param` are rejected at runtime. Every route must begin with a static segment:

```typescript
// ❌ Rejected
'/:slug': { component: ... }

// ✅ Allowed
'/pages/:slug': { component: ... }
```

### Outlet ID Pattern

When using Mode B (shell + router), the outlet element's `id` must match the pattern `` `router-${string}` ``. The default is `router-outlet`.

### Route Type Generation

Type-safe routing requires running `thane dev`, `thane build`, or `thane types` at least once to generate the `.thane/types/router/` type definitions. Until then, `route.params` is typed as `Record<string, string>` and `navigate()` accepts any string.

← [Back to Docs](README.md)
