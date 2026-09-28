# Lint Rules

Thane includes 12 compile-time lint rules (THANE400–THANE412; THANE406 is retired) that catch patterns the compiler cannot process correctly. These rules run during `thane dev` and `thane build` — errors prevent the build from completing, warnings are displayed but don't block.

The compiler reports a few more problems itself, while it compiles a template: see [Template Errors](#template-errors).

## Summary

| Code     | Rule                                                                        | Severity |
| :------- | :-------------------------------------------------------------------------- | :------- |
| THANE400 | [no-default-export-component](#thane400--no-default-export-component)       | Error    |
| THANE401 | [component-property-order](#thane401--component-property-order)             | Error    |
| THANE402 | [lifecycle-arrow-function](#thane402--lifecycle-arrow-function)             | Error    |
| THANE403 | [require-const-tagged-templates](#thane403--require-const-tagged-templates) | Error    |
| THANE404 | [no-nested-html-tags](#thane404--no-nested-html-tags)                       | Error    |
| THANE405 | [no-conditional-template-init](#thane405--no-conditional-template-init)     | Warning  |
| THANE407 | [single-component-per-file](#thane407--single-component-per-file)           | Error    |
| THANE408 | [component-const-declaration](#thane408--component-const-declaration)       | Error    |
| THANE409 | [no-aliased-component-export](#thane409--no-aliased-component-export)       | Error    |
| THANE410 | [no-cross-file-html-template](#thane410--no-cross-file-html-template)       | Warning  |
| THANE411 | [duplicate-mount-target](#thane411--duplicate-mount-target)                 | Warning  |
| THANE412 | [single-return-object](#thane412--single-return-object)                     | Error    |

---

## THANE400 — no-default-export-component

**Severity:** Error

Components must use **named exports**, not default exports. The compiler auto-derives the CSS selector from the export name.

```typescript
// ❌ BAD — default export, no name for the compiler
export default defineComponent(() => ({
  template: html`<div>Hello</div>`,
}));

// ✅ GOOD — named export, selector derived as "my-counter"
export const MyCounter = defineComponent(() => ({
  template: html`<div>Hello</div>`,
}));
```

---

## THANE401 — component-property-order

**Severity:** Error

Properties in the `defineComponent()` return object must follow canonical order: **template → styles → onMount → onDestroy**.

```typescript
// ❌ BAD — styles before template
export const A = defineComponent(() => ({
  styles: css`
    :host {
      color: red;
    }
  `,
  template: html`<div />`,
}));

// ✅ GOOD
export const A = defineComponent(() => ({
  template: html`<div />`,
  styles: css`
    :host {
      color: red;
    }
  `,
  onMount: () => {},
  onDestroy: () => {},
}));
```

---

## THANE402 — lifecycle-arrow-function

**Severity:** Error

Lifecycle hooks (`onMount`, `onDestroy`) must be **arrow functions**. Method shorthand and function expressions are rejected to ensure consistent lexical scoping.

```typescript
// ❌ BAD — method shorthand
export const A = defineComponent(() => ({
  template: html`<div />`,
  onMount() {
    console.log('hi');
  },
}));

// ❌ BAD — function expression
export const A = defineComponent(() => ({
  template: html`<div />`,
  onDestroy: function () {},
}));

// ✅ GOOD — arrow functions
export const A = defineComponent(() => ({
  template: html`<div />`,
  onMount: () => {
    console.log('hi');
  },
  onDestroy: () => {},
}));
```

---

## THANE403 — require-const-tagged-templates

**Severity:** Error

`html` and `css` tagged templates must use `const` declarations. Using `let`/`var` makes values opaque to the compiler's template processing pipeline.

```typescript
// ❌ BAD
let header = html`<header>Title</header>`;
var styles = css`
  :host {
    color: red;
  }
`;

// ✅ GOOD
const header = html`<header>Title</header>`;
const styles = css`
  :host {
    color: red;
  }
`;
```

---

## THANE404 — no-nested-html-tags

**Severity:** Error

`html` tagged templates must not be nested directly inside other `html` tagged templates. The compiler skips inner templates, so signal bindings inside them won't be processed.

```typescript
// ❌ BAD — nested html tag
template: html`<div>${html`<span>nested</span>`}</div>`;

// ✅ GOOD — extract to const variable
const span = html`<span>nested</span>`;
template: html`<div>${span}</div>`;

// ✅ GOOD — inside directives (allowed exception)
template: html`<ul
  >${repeat(items(), (i) => html`<li>${i}</li>`)}</ul
>`;
```

Templates inside directive callbacks (`repeat`, `whenElse`) are allowed because the compiler processes each callback's template independently.

---

## THANE405 — no-conditional-template-init

**Severity:** Warning

Variables holding `html`/`css` templates must not use conditional or logical initializers. The compiler cannot determine which branch is taken at build time.

```typescript
// ❌ BAD — ternary
const tpl = isAdmin ? html`<div>Admin</div>` : html`<div>User</div>`;

// ❌ BAD — logical AND
const tpl = show && html`<div>Content</div>`;

// ✅ GOOD — use whenElse for conditional rendering
template: html`<div>${whenElse(isAdmin(), html`<p>Admin</p>`, html`<p>User</p>`)}</div>`;
```

---

## THANE406 — retired

THANE406 (no-element-id) reported element ids of the form `b` followed by digits, which could collide
with the ids the compiler generated. Compiled code no longer uses ids to find anything, so any id is
the developer's own. The code is not reused.

---

## THANE407 — single-component-per-file

**Severity:** Error

Only one `defineComponent()` call is allowed per file. Multiple calls cause the compiler to process only one and silently skip the rest.

```typescript
// ❌ BAD — two components in one file
export const Foo = defineComponent(() => ({ template: html`<div />` }));
export const Bar = defineComponent(() => ({ template: html`<span />` }));

// ✅ GOOD — one component per file
export const MyCounter = defineComponent(() => ({
  template: html`<div />`,
}));
```

---

## THANE408 — component-const-declaration

**Severity:** Error

Components must be declared with `const`. Using `let` or `var` allows reassignment, which breaks the compiler's static analysis and can cause selector collisions.

```typescript
// ❌ BAD
export let MyCounter = defineComponent(() => { ... });
export var MyCounter = defineComponent(() => { ... });

// ✅ GOOD
export const MyCounter = defineComponent(() => { ... });
```

---

## THANE409 — no-aliased-component-export

**Severity:** Error

Components must be exported directly at their declaration site. Aliased exports and re-exports prevent the compiler from deriving the selector correctly.

```typescript
// ❌ BAD — aliased export
const _Internal = defineComponent(() => { ... });
export { _Internal as MyCounter };

// ❌ BAD — re-export
export { MyCounter } from './counter.js';

// ✅ GOOD — direct named export
export const MyCounter = defineComponent(() => { ... });
```

---

## THANE410 — no-cross-file-html-template

**Severity:** Warning

`html` template variables used inside `defineComponent()` must be defined in the **same file**. The compiler resolves templates via AST analysis and cannot process imported variables.

```typescript
// ❌ BAD — imported html template
import { header } from './shared-templates.js';
export const App = defineComponent(() => ({
  template: html`${header}<main>Content</main>`,
}));

// ✅ GOOD — template defined locally
const header = html`<header>Title</header>`;
export const App = defineComponent(() => ({
  template: html`${header}<main>Content</main>`,
}));
```

> Note: CSS imports _are_ allowed (`import styles from './Component.module.css'`). This rule only applies to `html` tagged templates.

---

## THANE411 — duplicate-mount-target

**Severity:** Warning

Detects multiple `mount()` calls targeting the same element or using the same default target (`document.body`). Duplicate mounts cause binding collisions.

```typescript
// ❌ BAD — two default mounts (both target document.body)
mount({ component: App });
mount({ component: Other });

// ❌ BAD — same explicit target
const el = document.getElementById('root')!;
mount({ component: App, target: el });
mount({ component: Other, target: el });

// ✅ GOOD — different targets
mount({ component: App, target: document.getElementById('app')! });
mount({ component: Nav, target: document.getElementById('nav')! });
```

---

## THANE412 — single-return-object

**Severity:** Error

A component's setup function returns **one object**. The compiler builds one static template per component, from the last object returned, so an earlier `return` would render the same template and lose its own hooks and styles. Returns inside nested functions (callbacks, helpers) are not counted.

```typescript
// ❌ BAD — an early return with its own template
export const Card = defineComponent(() => {
  const ready = signal(false);
  if (!ready()) return { template: html`<p>Loading…</p>` };
  return { template: html`<p>Ready</p>` };
});

// ✅ GOOD — one return object; the template chooses
export const Card = defineComponent(() => {
  const ready = signal(false);
  return {
    template: html`${whenElse(ready(), html`<p>Ready</p>`, html`<p>Loading…</p>`)}`,
  };
});
```

---

## Template Errors

These are reported by the compiler while it compiles a template, as build errors.

| Code     | What it reports                                                                                                |
| :------- | :------------------------------------------------------------------------------------------------------------- |
| THANE006 | An attribute written with a `:` prefix (`:src=${url()}`). Write `src=${url()}` instead                         |
| THANE007 | A `repeat()` row template without exactly one root element, including a row that is only a directive          |
| THANE008 | A `when()` on the root element of a `repeat()` row. Filter the list, or put `when()` on an inner element        |
| THANE009 | A template the compiler cannot bind reliably: markup the browser rebuilds (text directly in a table, an `<a>` inside an `<a>`, non-option content in a `<select>`), or a comment written like one of the compiler's own markers (`<!--b0-->`) |
| THANE010 | A function as `repeat()`'s third argument, which is the empty template. Pass the key function fourth: `repeat(items, row, null, (it) => it.id)` |
| THANE011 | A `repeat()` empty template that is not one static element: two roots, text outside an element, or a `${…}` in it. It is inserted as one element while the list is empty |
| THANE012 | A template reads a name that the compiled bindings declare for themselves (a name starting with `_`, an element name such as `b3`, or `e` and `item` in a row), so it would read the compiler's value. Rename the variable |

### THANE007 — one root element per row

```typescript
// ❌ BAD — two roots
${repeat(terms(), (t) => html`<dt>${t.term}</dt><dd>${t.def}</dd>`)}

// ✅ GOOD — one element that holds both
${repeat(terms(), (t) => html`<div><dt>${t.term}</dt><dd>${t.def}</dd></div>`)}
```

### THANE008 — no `when()` on a row's root

```typescript
// ❌ BAD
${repeat(items(), (item) => html`<li ${when(item.visible)}>${item.name}</li>`)}

// ✅ GOOD — filter the list
${repeat(items().filter((item) => item.visible), (item) => html`<li>${item.name}</li>`)}
```

### THANE010 — the key function goes fourth

```typescript
// ❌ BAD — the key function in the empty template's place
${repeat(items(), (item) => html`<li>${item.name}</li>`, (item) => item.id)}

// ✅ GOOD
${repeat(items(), (item) => html`<li>${item.name}</li>`, null, (item) => item.id)}
```

### THANE012 — names the compiled bindings keep for themselves

The binding code the compiler writes into each component declares variables of its own. Their names start with `_`, or are element names such as `b3`; in a list row the event parameter is `e`, and an item the source leaves unnamed is `item`. A template that reads a setup variable, import or global with one of those names would read the compiler's variable, so the build stops instead:

```typescript
// ❌ BAD — `_subs` is a name of the compiled bindings
const _subs = signal(0);
return { template: html`<p>${_subs()}</p>` };

// ✅ GOOD
const subscribers = signal(0);
return { template: html`<p>${subscribers()}</p>` };
```

### THANE011 — the empty template is one static element

```typescript
// ❌ BAD — text alone, two roots, a binding
${repeat(items(), (item) => html`<li>${item.name}</li>`, html`No items`)}
${repeat(items(), (item) => html`<li>${item.name}</li>`, html`<li>No</li><li>items</li>`)}
${repeat(items(), (item) => html`<li>${item.name}</li>`, html`<li>No ${noun()}</li>`)}

// ✅ GOOD
${repeat(items(), (item) => html`<li>${item.name}</li>`, html`<li class="empty">No items</li>`)}
```

← [Back to Docs](README.md)
