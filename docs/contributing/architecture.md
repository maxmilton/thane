# Architecture

## Project Structure

```
src/
  compiler/                    # Build-time compiler (runs in Bun)
    cli/                       # CLI entry point, argument parsing, config resolution, runBuild
    plugins/                   # esbuild plugin pipeline
      component-precompiler/   # Finds child component calls, runs the binding compiler, mount-call optimiser
      global-css-bundler/      # Bundles .css file imports as string exports
      minification/            # Selector rename plan; HTML and CSS transforms and minifiers the compiler calls
      post-build-processor/    # Final output processing (assets, index.html, gzip, size report, dev server)
      reactive-binding-compiler/ # Core: compiles html`` templates → DOM bindings (+ its tests)
      router-typegen/          # Generates .thane/types (route types, .css declarations)
      thane-linter/            # 12 compile-time lint rules (THANE400–THANE412) (+ its tests)
      tsc-type-checker/        # Type sync and TypeScript type checking at build start
    testing/                   # Shared helpers for build-through tests (not published)
    utils/                     # Shared compiler utilities (HTML parser, AST helpers, file scan, logger)
    errors.ts                  # Diagnostic codes (THANE006–THANE011, THANE200, THANE202, THANE400–THANE412)
  contracts/                   # Names shared by the compiler and the runtime's compiled-output contract
    compiler/                  # Binding kinds, parser states, the code generator's result type
    runtime/                   # Runtime helper names, package entry specifiers
    syntax/                    # Framework function names the compiler and linter recognise
  runtime/                     # Browser runtime (~3 KB gzip)
    signal.ts                  # signal(), computed(), effect(), batch(), untrack()
    component.ts               # defineComponent(), mount(), unmount(), registration factories, style scoping
    dom-binding.ts             # when/whenElse conditionals, keyed repeat reconciler
    router.ts                  # defineRoutes(), navigate(), route matching, scroll restoration
    types.ts                   # Signal<T>, ReadonlySignal<T>, ComponentRoot
    index.ts                   # 'thane': the public API barrel, global type declarations
    router-exports.ts          # 'thane/router': defineRoutes, navigate, navigateBack
    internal.ts                # 'thane/runtime': the helpers compiled code imports

e2e/                           # End-to-end Playwright browser tests
  contract-app/                # Test components exercising the compiler ↔ runtime contract
  router-app/                  # Router-specific test app
  cart-app/                    # Cart functionality test app
  browser-error-app/           # Dev-server error relay test app
  hardening-app/               # One probe component per fixed defect, and the shapes around it
  tests/                       # Playwright spec files
  .build/, test-results/       # Generated: app builds and Playwright output (ignored)

example-apps/
  benchmark/                   # js-framework-benchmark implementation (keyed reconciler stress test)
  store/thane/                 # E-commerce example app built with Thane (uses the checkout through `bun link`)
  store/react/                 # The same app built with React, for comparison

bench/                         # In-repo benchmark harness (bench/README.md)

docs/                          # Developer documentation
  contributing/                # This guide: setup, testing, architecture, contracts
  assets/                      # Logo and images used by the README

scripts/                       # Repo maintenance scripts: app type checks, package surface check,
                               # size report, compiled-output snapshots
```

Unit tests sit next to the code they cover (`*.test.ts`); they are excluded from the published build.

## Compiler Pipeline

`runBuild()` (`cli/build.ts`) first resolves the project root (the nearest folder above the entry with a `tsconfig.json` or `package.json`) and scans the working directory, and the project root when it lies outside it, for exported `defineComponent()` calls (`createBuildContext`, `utils/file-utils.ts`). That map of components by name is how child component calls are recognised. It is built once per `runBuild`; watch rebuilds reuse it.

The build is then an **esbuild plugin pipeline**, registered in this order. esbuild runs the `onStart` callbacks concurrently and waits for all of them before it loads a file, and for each file the first `onLoad` callback that returns contents wins.

1. **TSC Type Checker** (`onStart`) — syncs `.thane/types` (`syncProjectTypes`: the `.css` declaration file and one route-type file per `defineRoutes()` table), then type-checks the project with `ts.createProgram`. esbuild waits for it. A failed sync fails the build under the `types-sync` label
2. **Thane Linter** (`onLoad` `.ts`) — runs the rules on component files (THANE411 on files that call `mount()`); returns errors, otherwise nothing, so the next plugin loads the file
3. **Component Precompiler** (`onLoad` `.ts`, label `component-ctfe`) — the mount-call optimiser for files without templates; `css`-only modules; for files with `html` templates: replaces `${Child(…)}` calls with anchor comments, calls the reactive binding compiler (`transformDefineComponentSource`), compiles `css` templates and strips the `html` tags. An exception becomes the file's build error
4. **Global CSS Bundler** (`onLoad` `.css`) — `transformCss` on the file (`:host-context`, statement at-rules, planned renames, minify in prod or strip comments in dev), exported as a string
5. **Minification** (`onStart`, prod only) — reads the project's sources and plans selector renames into `buildContext.selectorMap`. Templates and stylesheets are minified by the compiler where it emits them; emitted JavaScript is minified by esbuild and never edited
6. **Post-Build Processor** (`onStart`, `onEnd`, `onDispose`) — `onStart` clears the source cache and empties the output directory (unless `emptyOutDir` is off); `onEnd` copies assets, writes `index.html` with the entry `<script>` tags from the metafile, compresses, prints the size report and starts the dev server

### One Component File

Inside the precompiler's `onLoad`, `transformDefineComponentSource` (`reactive-binding-compiler/index.ts`) compiles a component file from one parse of it:

1. Find the `defineComponent` call and its selector (explicit, or derived from the export name), and the initial values of `const x = signal(literal)` declarations.
2. Collect the templates of the setup's return objects (local `html` fragments inlined). A setup has one return object; THANE412 reports more.
3. Process each template (`template-processing.ts`, `repeat-analysis.ts`): parse it, find text, attribute, style and event bindings, and compile `when()`, `whenElse()` and `repeat()` content as sub-templates, at any depth, including directives inside list rows.
4. Build the DOM model of each template as emitted (`dom-model.ts`, the browser's tree construction) and compute, for every bound node, the shortest path of DOM properties from its scope's starting nodes: the component template's elements, a branch's first node, a row element.
5. Generate the code (`codegen.ts`): the `__b` binding function, branch initializers and row factories. Lists at every level are emitted by one generator, `emitRepeat`.
6. Apply every change to the source as one list of edits: the registration call, the static templates, `__b`, and an import of exactly the runtime helpers the code uses, from `thane/runtime`.

## Runtime Architecture

The runtime is intentionally minimal:

- **Signals** — reactive primitives with push-based notification, deferred cascades and batching
- **Components** — `defineComponent` wrapper, registration factories, scoped styles via `adoptedStyleSheets`
- **DOM Binding** — conditional rendering (`when`/`whenElse`) between comment anchors and keyed list reconciliation (`repeat`)
- **Router** — single-instance client-side router with History API, lazy loading, scroll restoration

The compiler generates a `__b(ctx, elements)` function inside each component's return object that initializes all reactive bindings when the component mounts. The registration factory clones the template, lists the clone's elements before inserting it, and passes that list: compiled code reaches every node it binds by a compile-time path from one of those elements, never by id or by searching the DOM. The compiled-output contract is described in [Contracts](contracts.md).

---

← [Back to Contributing](README.md)
