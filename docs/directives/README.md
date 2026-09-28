# Directives

Directives extend Thane's template syntax with conditional rendering and list rendering. They are global functions available inside `html` templates — the compiler transforms them into optimized DOM operations.

## Overview

| Directive | Purpose | Syntax |
|:----------|:--------|:-------|
| [`when()`](when.md) | Show/hide a block based on a condition | `<div ${when(condition())}>...</div>` |
| [`whenElse()`](when-else.md) | Render one of two branches | `${whenElse(cond(), thenHtml, elseHtml)}` |
| [`repeat()`](repeat.md) | Render a list with keyed reconciliation | `${repeat(items(), renderFn, emptyTpl, keyFn)}` |

## How They Work

Unlike frameworks that use a virtual DOM to diff entire trees, Thane directives operate at the DOM level:

- **`when`** keeps its content between two invisible comment anchors: it inserts cloned content between them on show and removes it on hide. Nested bindings are initialized on show and disposed on hide.
- **`whenElse`** keeps its two branches between three anchors and swaps between them. A branch may have any number of root nodes, text included. Only the active branch has live bindings.
- **`repeat`** uses a keyed reconciler that tracks item identity. It adds, removes, reorders, and updates DOM nodes directly — no diffing of the full list.

## Nesting

Directives can be freely nested. Every directive's content is compiled as its own sub-template, so the same rules apply at any depth:

- `when`, `whenElse` and `repeat` inside `repeat` items, including lists nested in rows at any depth
- `when`, `whenElse` and `repeat` inside `whenElse` branches
- `when`, `whenElse` and `repeat` inside `when` blocks
- Event handlers and child components inside any of the above

Bindings inside hidden content are disposed and re-created each time it is shown, so a block that is hidden and shown again always reflects the current signal values.

Two shapes are build errors, because a list moves each row by its one root element: a row with more than one root element, or none (THANE007), and a `when()` on a row's root element (THANE008).

## Detail Pages

- [when — Conditional Rendering](when.md)
- [whenElse — If/Else Rendering](when-else.md)
- [repeat — List Rendering](repeat.md)

← [Back to Docs](../README.md)
