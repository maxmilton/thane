# Contracts

The `src/contracts/` directory defines shared constants and types that both the compiler and the runtime depend on. This prevents stringly-typed coupling — if either side drifts, import errors or test failures catch it immediately.

## Structure

```
src/contracts/
  index.ts                    # Barrel re-exports
  compiler/
    kinds.ts                  # Binding kind enums (text, attribute, style, event, etc.)
    bind-functions.ts         # Binding function name constants
    generated-artifacts.ts    # Compiler output artifact constants
    template-edits.ts         # Template edit / transform type constants
  runtime/
    internal-helpers.ts       # __b, __dc, __registerComponent — names the compiler emits
    router.ts                 # Router internal constant names
  syntax/
    directives.ts             # when(), whenElse(), repeat() function name constants
    framework-functions.ts    # html, css, signal, computed, etc. — names the linter checks
    tags.ts                   # Tagged template literal name constants (html, css)
```

## The compiled-output contract

Compiled components and the runtime of the same Thane version agree on these calls. Pre-compiled
components must be rebuilt with the matching version.

- `__registerComponent(selector, setup, template)` / `__registerComponentLean(selector, setup, template)`
  return `{ __f(target, props?, extras?) }`. The factory clones `template`, lists the clone's elements
  (`querySelectorAll('*')`, before the clone is inserted, because the target may hold other nodes),
  appends the clone to `target` and calls the setup result's `__b(ctx, elements)`.
- `__b(ctx, elements) → cleanup?`: the component's binding function. `elements[i]` is the template's
  i-th element in document order; compiled code reaches every node it binds by that position or by a
  path from it, never by id. Inside a `when()` / `whenElse()` branch, the branch initializer reaches
  its nodes by path from the branch's first node, and a row factory from the row's element.
- Compiled templates carry no generated id. A text binding writes the text node that follows an empty
  comment (`<!---->`); a list's rows go before its anchor, an empty comment; a child component's host
  element is in the template where the child was written, or, where the browser's parser would not keep
  an element there (directly in a table row, inside svg), an empty comment that the compiled code
  replaces with a host it creates.
- `__bindIf(start, end, signal, template, initNested)` and
  `__bindIfExpr(start, end, signals, evalExpr, template, initNested)`: a `when()` / `whenElse()` branch
  is everything between the comment anchors `start` and `end` (a `whenElse()` has three anchors, its
  branches share the middle one), with any number of root nodes. Whatever is between them when the
  binding starts is the pre-rendered branch. Show inserts `template` before `end`; hide removes every
  node between the anchors, then runs the branch's cleanups. `initNested(first)` receives the branch's
  first node and returns its cleanups.
- `createKeyedReconciler(container, anchor, createRow, keyFnOrProp, batch?, trackIndex?)` →
  `{ reconcile, clearAll, get }`, where `anchor` is the list's anchor node in `container` (a comment);
  `__dc(instance) → destroy`; `__sig` = `signal`;
  `__enableComponentStyles()`; `mountComponent(component, target?, props?)`.

## Policy

When a change touches compiler ↔ runtime coupling:

1. **Add or update values** in `src/contracts/` first.
2. **Import contract constants/types** into compiler and runtime code — never duplicate string literals.
3. **Keep compiler-generated helper names** aligned with `src/contracts/runtime/internal-helpers.ts`.
4. **Run both test suites** to confirm the contract holds:
   ```bash
   bun run test
   bun run e2e:test
   ```

If you add a new directive, binding kind, or internal helper:

1. Add the constant to the appropriate contracts file.
2. Update the compiler plugin that emits it.
3. Update the runtime function that handles it.
4. Add unit tests and E2E tests confirming the round-trip.

---

← [Back to Contributing](README.md)
