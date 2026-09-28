# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Two sets of changes: the fixes found by porting a real Angular site (routing, forms, Firebase) to Thane, and a simplification and hardening round over the whole framework (see Internal), which also narrows the public API to what apps use and changes the compiled output. Components compiled by an earlier version must be rebuilt.

### Breaking

- **`thane` exports what apps use, and nothing else.** It keeps nine values (`signal`, `computed`, `effect`, `batch`, `untrack`, `defineComponent`, `mount`, `unmount`, `registerGlobalStyles`) and six types (`Signal`, `ReadonlySignal`, `ComponentContext`, `ComponentHTMLSelector`, `MountHandle`, `RoutePaths`). Removed, with the migration:
  - `mountComponent`: call `mount({ component, target, props })`. The compiler still turns a component-only `mount()` into `mountComponent`, now imported from `thane/runtime`.
  - The `html` and `css` runtime string shims: templates use the global `html` and `css` tags, which need no import.
  - The types `ComponentRoot`, `ComponentReturnType`, `MountOptions`, `Route`, `RouteComponent`, `LazyRouteComponent`, `EagerRouteComponent`, `RoutesMap`, `RoutesConfig`, `RegisteredRoutes`, `RouterConfig`, `ScrollRestorationConfig`, `ExtractRouteParams`, `RouteToPath`, `RouteContextForSelector`, `UntypedRouteContext`: TypeScript still infers each of them where you write the object, and editors still show them in hovers; where you need a name, write `HTMLElement` for `ComponentRoot`, `Parameters<typeof mount>[0]` for `MountOptions`, or the shape itself.
  - `Register` and `RouteComponentRegister`, the targets of `declare module 'thane'` augmentation: route typing comes from the generated `.thane/types` files, which augment the global `ThaneTypeRegistry`. Delete any hand-written augmentation.
- **`thane/router` exports `defineRoutes`, `navigate` and `navigateBack` only.** `matchRoute`, `startRouter` and `stopRouter` (internal) and every type (`RouteParamNames`, `RouteParamsObject` and the router types above) are gone from it.
- **`thane/compiler` and `thane/compiler/cli` are removed.** They re-exported the compiler's internals. Build with the `thane` CLI and `thane.config.json`.
- **The compiled-output contract changed.** Compiled code now finds every node by a path computed at build time, and compiled templates carry no ids: `__bindIf(start, end, signal, template, initNested)` and `__bindIfExpr(start, end, signals, evalExpr, template, initNested)` work over two comment anchors, `__b(ctx, elements)` receives the template's elements, list anchors and child placeholders are comments, `createKeyedReconciler`'s batch argument is built by `__batchRows`, and templates are built by `__T`. Components compiled by an earlier Thane version, for example shipped pre-compiled in a library, must be rebuilt with this one. [Contracts](docs/contributing/contracts.md) describes the contract.
- **A function as `repeat()`'s third argument is a build error (THANE010), and the global `repeat` type rejects it** (`emptyTemplate?: string | null`). The third argument is the empty template: a key function there used to become the empty template's markup, the list was keyed by index, and emptying it threw a `TypeError`. Pass the key function fourth: `repeat(items(), row, null, (item) => item.id)`.
- **A `repeat()` empty template must be one static element (THANE011).** It is inserted as one element while the list is empty: only a first element was ever shown, text alone threw when the list emptied, and a `${…}` in it was shown as written. Wrap the content in one element, and put an empty state that changes in a `when()` next to the list.
- **THANE406 (`no-element-id`) is retired.** Compiled code no longer uses ids to find anything, so an `id` of the form `b0` cannot collide with anything. The code is not reused.
- **`--app` and the `app` config key are removed.** They had no effect. `--app` is now an unknown flag, which prints a warning, and the word after it is read like any other argument: `thane --app dev` runs `dev`. Remove `--app` from scripts.
- **CLI flags that take a value follow one rule, with or without a config file:**
  - a value flag never takes a following flag as its value: `thane dev --host --open` is a bare `--host` and `--open` (without a config file, `--entry --prod` used to set the entry to `--prod`);
  - a bare value flag stands for its fallback even when a config file sets the option (it used to keep the config file's value): bare `--host` is `0.0.0.0`, bare `--port` is `4200`, and `--base`, `--target`, `--env-prefix` and `--legal-comments` fall back to their defaults;
  - `--port` accepts digits only: `--port abc` (which gave `NaN`) and `--port 3000x` (which gave 3000) stop with an error;
  - an argument that is neither a command nor a flag's value (`thane biuld`) prints "Unknown command"; the build then runs as before.

### Changed

- **`whenElse()` branches may have any number of root nodes, text included.** A branch is everything between two comment anchors, and showing or hiding it moves the whole range. A branch with several roots used to leave its extra roots on screen when it hid, and a text-only branch never toggled.
- **`:host-context(X)` works in component styles.** The compiler rewrites it to `X &`, which the runtime scoper turns into `X .my-card`: the rule applies when an ancestor matches `X`. `:host(X)` styles the component element itself. It used to produce an invalid selector that the browser dropped with its whole rule.
- **Whitespace in templates.** Content of `<pre>`, `<textarea>`, `<script>` and `<style>` in component templates is kept as written, in development and production builds (it was collapsed), and whitespace next to such an element collapses to one space. A space between a text binding and its neighbour, whether another binding, an element or a directive, is kept in rows, components and branches: `<b>Name:</b> ${name()}` rendered "Name:John" in a row, and `${a()} <b>x</b>` rendered "Ax". Whitespace-only text between two elements is still removed, so `<b>x</b> <i>y</i>` renders "xy".
- **`@import` in a stylesheet is removed at build time, with a warning.** Thane applies every stylesheet as a constructed stylesheet, and browsers ignore `@import` there; load such a file with a `<link>` in `index.html`. `@charset` is removed too, and `@layer a, b;` is written as empty `@layer` blocks, so none of them unscopes the rule after it any more.
- **New build error THANE009** for a template the compiler cannot bind reliably: markup the browser rebuilds where a binding needs a position (text directly in a table, an `<a>` inside an `<a>`, non-option content in a `<select>`), or a comment in the form of the compiler's own markers (`<!--b0-->`). THANE007 now also reports a `repeat()` row that is only a nested `repeat()`: the list could not move such a row with its inner rows.
- **`thane/runtime` is the compiler's own entry.** Compiled components import their helpers from it, including `mountComponent`, `__batchRows`, `__T` and `__nc`. Apps must not import it: it is not an API, and it changes whenever the compiled output does.
- **Route parameters are decoded.** `/users/ada%20lovelace` gives `route.params.id` the value `ada lovelace`, as other routers do; it was `ada%20lovelace`. A segment that is not valid percent-encoding is kept as written.

### Fixed

- Navigating between routes no longer flashes. The router tore the current page down and then waited for the next page's chunk, so the outlet was painted empty for as long as the chunk took (about 200 ms on a first visit over a typical connection) and for one frame even when it was cached: the document collapsed to the shell and the footer jumped to the top. The current page now stays mounted until the next component has arrived, and the swap and the scroll write happen in one task; a new page is no longer painted for a frame at the previous page's scroll offset. `currentPath()` still changes as soon as the navigation starts.
- A navigation overtaken by a newer one never mounts. The guard compared the location with the last requested URL, which were equal again by the time a slow chunk arrived, so the overtaken page mounted on top of the newer one under the newer URL. Each load takes a ticket and stands down when a newer one exists. Returning to the page on screen while another page loads cancels that load and keeps the current instance and its state. The scroll action and saved position belong to the load that was started with them, and the scroll position is not persisted while the URL and the page on screen disagree.
- Production builds never edit emitted JavaScript. The template minifier used to run over every emitted file and guess which template literals were HTML or CSS from what they contained, with a scanner that could not tell a regex literal from a division: bundling the Firebase SDK silently broke Firestore's transport, and a `'\n'` separator in application code was emptied. Templates and stylesheets are now minified inside the compiler, where it emits a template or reads a `css` template or a `.css` import, so the language is known instead of guessed. esbuild is the only thing that minifies JavaScript and the emitted files are never read back, so a library cannot be affected whatever it contains and however the bundle is split, including `splitting: false`, where library and application code share one file. One-line templates and stylesheets are minified too (the output scanner skipped them).
- Selector minification works again, and is planned from the sources instead of patched into the output. It searched the output for a `selector: '…'` property that compiled `defineComponent()` code never contains, so nothing was ever renamed. Before a production build compiles anything, Thane reads the project's own TypeScript, stylesheets and `index.html` and renames a selector only when every appearance of its text is a place the compiler writes itself: the registration, the host element of a child, a tag in `index.html`, a `.selector` class in a `css` template or an imported `.css` file. Any other appearance (a route path, a `class` attribute, `querySelector`, a static stylesheet, a stylesheet imported from a package, a comment or string inside CSS) keeps the selector's name everywhere. A generated name is never one already in use, stylesheets from packages are never renamed in, and a string in a library that happens to spell a selector is not touched.
- `css` templates keep their escape sequences. The compiler re-emitted the cooked text, so `content: "\\201C"` reached the output as `\201C` inside a template literal: a syntax error for an octal-looking escape and a silently wrong character for an icon-font code such as `\\e900`. Substitutions in a `css` template are located by the parser instead of by scanning for `${`, so an expression holding a brace or a colon is never read as CSS, and a `css` template nested in a substitution is compiled too.
- A module that holds only `css` templates (shared styles) is compiled. The tag exists only at compile time and such a module was skipped, which left a call to an undefined `css` in the output. A `css` tag that a module imports from another library or declares itself is left alone.
- The CSS minifier keeps the spaces `calc(a + b)` needs and no longer turns the descendant selector `.a :hover` into `.a:hover`. Quoted strings are copied verbatim and the last semicolon of a block is dropped.
- Minifying `index.html` no longer collapses the line breaks of an inline `<script>` (a `//` comment swallowed the rest of the script) or touches `<style>`, `<pre>` and `<textarea>` content. The same holds for a `<pre>` or `<textarea>` inside a component template.
- `style="width: ${w()}px"` dropped the `px` on every update, and `margin: ${a()}px ${b()}em` compiled to two writes that overwrote each other. A declaration value with static text or several expressions is one binding written as a template literal, and a `;` or `:` inside an expression no longer confuses the declaration split.
- The entry `<script>` was not injected into `index.html` when the entry point came from `thane.config.json`: the config loader makes it absolute and it never matched the metafile's relative path.
- The dev and serve server decode request paths, so assets with spaces or non-ASCII characters in their names are served instead of 404. Containment is checked on the decoded path.
- Generated route types list the paths as string literals instead of importing `typeof Routes`. A lazily loaded page that called `navigate()` in its own template was part of its own type (TS7022) unless the loader carried a return type annotation.

The simplification and hardening round fixed these defects in valid code:

- A `repeat()` row binding that calls a method on the item, such as `${it.name.toUpperCase()}`, no longer throws `ReferenceError` at mount: the outer signals in row bindings are found with the same syntax-tree detector as everywhere else, instead of a pattern that took `toUpperCase()` for a signal read.
- Template text keeps its escapes. Backslashes were lost, and an escaped `\${x}` became a live interpolation; templates are now carried as written, so `\${` is literal text, as in any template literal.
- Whitespace inside `<pre>`, `<textarea>`, `<script>` and `<style>` in component templates is kept, in development and production builds; it was collapsed, although the documentation promised otherwise.
- A hyphenated tag at the root of a `whenElse()` branch, or carrying `when()`, keeps its name; it was rewritten to `<my id="…" -tag="">`.
- Clearing a list no longer deletes static siblings in the same container, such as a `<select>`'s placeholder `<option>`: the container is emptied in one step only when it holds nothing but the list.
- A nested list directly inside a row's root element no longer reorders the outer rows when it goes from empty to non-empty.
- The setup function's return object is found by one rule: return statements at any depth of the setup, but not inside nested functions. A nested `function` that returned an object made the compiler drop `onMount`.
- A comment or a string containing `defineComponent(` before the real call no longer receives the selector and the registration (the app rendered blank), and type arguments with a call signature (`defineComponent<{ (): T }>(…)`) no longer leave an undeclared `defineComponent` in the bundle: the compiler edits the file at positions from its syntax tree.
- Components whose path contains `scripts` (for example `src/transcripts/`) are compiled; they were skipped.
- Importing from `thane/router` before `thane` in a component file no longer fails the build: the compiler's helpers are imported next to the `defineComponent` import, and a user path containing `dom/index` or `shadow-dom` is no longer taken for Thane's.
- `style="--w: ${w()}"`, a custom property bound to a bare signal, builds and is written with `style.setProperty`.
- A brace inside a string inside `${…}` (`${on() ? '}' : '{'}`) no longer breaks the template: one expression scanner, which skips strings and nested template literals, reads every `${…}`. The same fix removes a stray `)}` that `${fmt({ a: item.a })}` rendered in every row.
- The mount-call optimiser rewrites `mount()` only when the file calls `mount`, imported from `thane`, exactly once: two `mount()` calls with different targets both work, and a local function named `mount` is left alone.
- `.scss`, `.pcss` and similar files are no longer claimed by the CSS bundler and injected raw: the bundler handles `.css` only, and esbuild reports that it has no loader for the others.
- Building with a working directory outside the project compiles its child components: the project folder is scanned as well as the working directory.
- A child-component row inside a directive no longer throws `ReferenceError: __dc is not defined` when shown: each component imports exactly the runtime helpers its compiled code uses.
- A child component inside a `whenElse()` that is nested in another directive is mounted.
- Directives nested in `repeat()` rows work at any depth. Event handlers in the rows of a nested list and in a row's `whenElse()` branches, bindings inside a `when()` in a nested row, child components in a row's `when()`, and a list inside a row's `when()` were silently dropped. A row of a `Signal<Signal<T>[]>` list that tested its item in a `when()` threw `ReferenceError` when shown, and a row `when()` whose condition was true at build time rendered garbled markup.
- Runtime style scoping keeps `:host()` conditions with parentheses of their own (`:host(:not(.x).y)` became `:not(.x.y)`); `:host-context()` works (see Changed); and in development builds a quote inside a CSS comment no longer unscopes every later rule, which then applied to the whole page: comments are removed at build time in development too.
- `mount({})` without a `component` throws "Invalid mount component" instead of a `TypeError`.
- A compile error is printed once, labelled `[plugin component-ctfe]`, instead of twice with the label `[plugin: reactive-binding]`, and an error while finding a file's child components fails the build instead of compiling the file without them.
- The unused HTML bootstrap plugin is removed, and with it the log lines "Detected Mode B/C", "Bootstrap component: …" and "No shell component…", and a spurious error when the shell component came from a package.
- The dev server's browser-error relay resolves stack locations the way it resolves requests: decoded, and only inside the output directory.
- CLI flags that take a value follow one rule, `--port` refuses anything but digits, and an unknown command is reported: see Breaking.
- The size report follows `NO_COLOR` and plain (non-terminal) output, and a log without colour no longer shows a literal `%s` after every file name and size.
- `thane serve --prod` writes an edited `index.html` minified, as the build does; it was written unminified.
- Builds are reproducible: compiled output no longer depends on the absolute path of the checkout, whose hash seeded the generated ids, so two checkouts of the same source produce identical bundles and file names.
- Lists clean up their rows when their scope ends. After a component was destroyed or a `when()` hid, its rows' subscriptions to outer signals stayed alive and piled up on every show, and child components in rows never got `onDestroy`.
- A child component in a row whose props use a named index no longer throws `ReferenceError: _idx is not defined`.
- A `whenElse()` branch with several root nodes hides completely, and a text-only branch toggles (see Changed).
- A same-length list update with more than two displaced rows before a new key no longer throws a `TypeError` half-way through and leaves the list inconsistent.
- A row text binding after a void element or a comment writes to its own text node (it went to the `<img>`, or nowhere), and a `<` in an attribute value of the row's parent (`<li title="a<b">`) no longer fails the build.
- A concise setup body in two sets of parentheses with `styles`, `() => (({ template, styles }))`, no longer throws `ReferenceError` at mount.
- `--help`, `-h`, `--version` and `-v` print and exit when a config file exists; they ran a build.
- A namespaced closing tag (`</svg:rect>`) matches its opening tag; it was reported as orphaned and unclosed.
- `@layer a, b;`, `@charset` and `@import` in a component stylesheet no longer leave the next rule unscoped, applied to the whole page (see Changed).
- The dev server answers 404 when the output directory has no `index.html`, instead of crashing its request handler.
- A setup function with more than one `return {…}` is a build error (THANE412). Every branch rendered the last object's template, with the first object's hooks and styles.
- A child component in the rows of a list inside a `when()` or `whenElse()` no longer makes the mount throw.
- An attribute binding in a row's `when()` content is set on first show when the condition reads only component signals; it stayed empty until the branch was hidden and shown again.
- A literal `<` in template text that does not open a tag no longer shifts every later position and garbles the compiled template.
- In a row, a child component placed after a `when()` whose initial value is unknown mounts in its own place, not in the `when()`'s.
- A component-call row with a template literal in its props, ``(item) => Card({ label: `x${item.label}` })``, no longer throws `ReferenceError` when a row is created.
- An event handler on an element with `id=""` no longer throws at mount.
- Of two attributes with the same name, the first is kept, as browsers do, and the second is reported. The later one used to win: a binding was lost, and its `${…}` stayed a live interpolation in the static template.
- A `when()` on a list row's root element is a build error (THANE008). It left removed rows on screen and duplicated rows on reorder; filter the list, or put the `when()` on an inner element.
- A same-length reorder with more than two displaced rows updates every row whose item changed; rows after the third kept showing their old values.
- The documented `tsconfig.json` (`"types": ["thane/client"]` without `skipLibCheck`) no longer fails every `thane build` with TS2300 "Duplicate identifier 'css'": the generated `.thane/types/client.d.ts` refers to the package's declarations instead of copying them.
- A list update that removes one row and changes another no longer leaves stale rows on screen without creating the new one.
- After a one-row removal, kept rows whose item changed show the new item.
- A key function passed as `repeat()`'s third argument no longer compiles into a list that is keyed by index and throws when it empties: it is a build error (see Breaking).
- Two text bindings separated by a space in a `repeat()` row keep the space: `${it.first} ${it.last}` rendered "JohnDoe".
- A space between a text binding and an element or directive next to it is kept, in rows, components and branches, development and production (see Changed).
- A child component call in a template, `${Kid(…)}`, mounts the component the file declares or imports under that name. It was matched by name against every component in the project, so two components exported under one name from different folders collided, and a plain function named like a component elsewhere was compiled as a child mount. Imports are followed through re-exports, aliases and tsconfig `paths`.
- In nested lists, an inner row reads an outer row's item under the name the source gives it, whatever that name is. Compiled rows called every item `item`, so with a list of signal items named `item`, `item()` in an inner row read the inner item and threw.
- An escape that only a tagged template allows, such as `` html`C:\users` `` (`\u` without hex digits, `\x1`, `\08`, `\9`), is shown as written. The template is emitted into an ordinary template literal, where such an escape failed the build.
- An attribute expression that holds double quotes, such as `class=${sel() === it.id ? "on" : ""}` in a `repeat()` row or `data-x="${it.label + "!"}"`, builds and binds. The parser ended the attribute value at the first quote inside the expression, so the row failed the build with a misleading THANE006, and a double-quoted value lost its binding.
- A setup variable named `r` or `ctx` is read as the setup declares it in the component's template: the compiled bindings called the component root `r` and their context `ctx`, so `${r()}` called the root element. The bindings' own names now start with `_`, and a template that still reads one of them (a name starting with `_`, an element name such as `b3`, or `e` in a row) is a build error, THANE012, instead of a wrong value.
- `@namespace` in a component stylesheet no longer leaves the rule after it unscoped, applied to the whole page. The build writes an empty block after the statement, so the runtime scoper copies the statement and scopes the next rule; the namespace applies as usual.
- The mount-call optimiser leaves an entry alone when it also uses `mount` as a value (`const m = mount`, `export { mount }`); it removed the import, and the file broke.
- `thane serve --prod` answers a request that fails with a plain 500. It started Bun's server without `development: false`, so a failing request showed Bun's development error page with the stack trace.
- Template parse warnings, such as a duplicate attribute, are reported for `whenElse()` branches and `repeat()` rows too, once each; only the component template's were.
- A missing space after a tag name, `<button@click=${go}>` or `<div${when(on())}>`, is reported, and the rest of the tag is read as its attributes. The character was dropped and the name went on, so the example became a `<buttonclick>` element with no handler.
- A config file key that nothing reads, such as a misspelled `outdir`, prints a warning with the key it most likely means; so do an unknown command in `commands` and a section that is not an object. They were ignored silently.
- Lint rules:
  - THANE411 no longer warns about a duplicate target for `mount({ target })` (shorthand) or `mount({ 'target': el })`. It read both as the default target, document.body. It also treats `target: document.body` as the default target, and `el!` or `(el)` as `el`. It no longer analyses the old `mount(App, target)` form.
  - THANE403 and THANE408 report a `using` declaration as `using`; they called it `var`.
  - THANE402 reports a shorthand `onMount`, an accessor and a string-named hook.
  - THANE401 and THANE402 inspect `return ({…})`.
  - THANE407 counts every `defineComponent()` call, a bare or parenthesised one too.
- Router:
  - route parameters are decoded (`%20` is a space); a malformed escape is kept as written. See Changed;
  - `scrollRestoration: null` counts as the default. It threw, and left the router stuck as "already started";
  - a shell without its outlet is destroyed again before the error, instead of staying mounted;
  - `navigate()` pushes no scroll state when scroll restoration is off.
- Deleting a folder under the assets folder while `thane dev` runs removes it from the output. On Windows the emptied folder could stay: its last event could be a `change`, which was ignored, and removing the folder and its file at the same moment could fail.
- A production build's short selector names depend only on the components its entry points reach. Every component under the project was planned, so adding one anywhere (another app, a test fixture) renamed the selectors of an app that never used it. Selectors named in the project's other sources, such as its e2e tests, still keep their names.
- A shorthand property that names a row's item, such as `{ row }` in a handler inside a row's `when()` or `whenElse()`, compiles to `{ row: … }`. It failed the build. Row expressions are also rewritten without being printed again, so a template inside keeps its `html` tag as written.

### Removed

- The JS output optimizer plugin. Its result was never written to disk (the minification plugin wrote the files before it ran), and a second esbuild pass over esbuild's own output makes a bundle larger, not smaller: +7 KB on a 1.5 MB application when applied by hand.

### Internal

- A simplification and hardening round over the compiler and the runtime. Dead and duplicated code went: a compile-time evaluator whose result nothing read, a fallback copy of the binding compiler that only ran after the first had failed, a bootstrap plugin whose result nothing read, about 160 exported internal names, and the contract constants nobody imported. Each build now syncs the generated types once; each component file is parsed once and edited through one list of edits at syntax-tree positions; one template processor serves the component and every branch; and one generator emits the lists and branches of every level, rows included, which is what makes directives nested in rows work. Compiled code finds its nodes by paths computed on a model of the browser's HTML tree construction, checked against Chromium on 496 templates, instead of by generated ids and a `TreeWalker`; that also made builds reproducible. The reconciler's batch path became a helper of its own, bundled only by apps with a batched list, and the template helpers are shared from `thane/runtime` instead of being emitted into every component file. An effect or computed disposed during its own run no longer keeps one subscription alive. Framework source went from 17,470 to 14,722 lines. The unit tests went from 470 to 1,359, and the e2e suite gained a hardening app with a probe for each defect fixed (142 tests in the Chromium projects); `bun run check:exports`, `bun run size` and output snapshots (`bun run snapshot:output`, `snapshot:compare`) check the package surface, the sizes and the compiled output. On the in-repo js-framework-benchmark harness, measured after every phase, no operation of the standard benchmark got slower, and the benchmark app's bundle went from 3,812 to 3,731 B gzip.

## [0.2.0] - 2026-09-15

The first release after the September 2026 performance spike and bug audit. Breaking changes: a `:`-prefixed attribute is a build error (THANE006) instead of a literal attribute, a `repeat()` row template with more than one root element is a build error (THANE007) instead of a slow fallback, and `whenElse()` branches and `when()` content are compiled as sub-templates, which changes what nested directives inside them can do (more), not the syntax.

### Added

- `bench/`: a self-contained benchmark harness that builds the js-framework-benchmark app from the working tree, drives it in Chrome, and records the same trace-derived total, script, paint and memory metrics as the official runner. `bun run bench --label <name>` measures a build and `bun run bench:compare <a> <b>` compares saved labels with a significance test; `--interleave` measures two builds in alternating iterations for a fair A/B.

### Performance

Measured with the in-repo harness against the previous release on the js-framework-benchmark operations, both builds interleaved in one session (script time, medians): select row 0.26x, partial update 0.59x, append rows 0.83x, replace rows 0.91x, create rows 0.93x, clear rows 0.93x, create 10,000 rows 1.02x; geometric mean 0.77x. Heap after creating 1,000 rows 0.95x.

- Every write compiled into a `repeat()` row (and expression bindings at component level and inside conditionals) keeps the last value it wrote and skips the DOM write when a re-evaluation produces the same value. Creating rows no longer issues `setAttribute('class', '')` per row when the class starts empty.
- A row attribute of the form `signal() === item.<key> ? 'on' : 'off'` (also `!==`, or the operands swapped), where `<key>` is the repeat's trackBy property, is driven by one subscription on the list that rewrites only the two affected rows, instead of one subscription per row. Rows still compute the value when created.
- Sole-content text bindings in rows write `Text.nodeValue` on update, resolving the text node lazily on the row's first update; creation still uses `textContent`.
- Dynamic `class` attributes on HTML elements are written through `className`; inside `<svg>` they stay on `setAttribute`.
- Appending items to a non-empty `repeat()` list takes a fast path that creates only the new rows, and the container is no longer detached and re-attached for appends.
- Unsubscribing from a signal is constant time; tearing down a list of subscribed rows no longer moves O(n²) array elements.
- Delegated row event listeners dispatch by the row child the event came through instead of running a containment probe per handler.

A second round, measured the same way against the build above: create 10,000 rows 0.88x, append rows 0.91x, partial update 0.86x, create rows 0.97x (30 interleaved iterations), everything else the same; geometric mean 0.96x. Heap after creating 1,000 rows 0.97x. Combined with the round above, script time is about 0.74x of the previous release.

- `repeat()` rows that need no per-row cleanups (no subscriptions, nested directives or child components) are cloned in batches of 16 from a fragment built once per list, and bound and inserted per batch instead of per row.
- Those rows no longer carry an update closure. The row's record holds the last-written value per binding and its lazily resolved text nodes, and one update function per list re-navigates from the row element; rows also share one empty cleanups array. Heap after creating 1,000 rows drops by about 5%.
- Reconciling a list against an array of the same length matches rows by position before deriving keys: an identical item needs nothing, an item whose key matches the row at that index is updated in place, and only a moved row falls through to the keyed paths.
- Unsubscribing from a `computed()` is constant time, like plain signals.

A third round, measured the same way: swap rows 0.70x (0.60 to 0.41 ms), partial update 0.83x, everything else the same; geometric mean 0.94x. Across the three rounds, script time is about 0.70x of the previous release.

- Reordering a list of the same length compares each row with the item at its index before deriving a key, so a swap of two rows in a list of 1,000 costs two lookups instead of a key derivation and a lookup per row.
- The shared update function of lean rows navigates to a bound element only inside the guard of a binding that changed; an unchanged binding costs one compare.

A fourth round, measured the same way against the build above (30 interleaved iterations on the creation and update benchmarks): every operation "same"; geometric mean 0.98x. The bug fixes above cost nothing on the benchmark app, whose bundle is byte-identical through the fallback removal, developer-id and props changes.

- The keyed reconciler builds its key map lazily: creating rows no longer inserts every row into a Map; the map is built the first time an operation needs many lookups, and a handful of lookups (a selection, a swap) scan the rows instead.

### Fixed

- `repeat()` rows with an attribute binding on an item element, such as `<tr data-id=${item.id}>` or `<a href=${item.url}>`, compiled to the fallback renderer, which re-renders every row's HTML on each change. They now use the optimised row path, and an attribute that mixes a signal with item data on an element below the row root is written to that element instead of the row element.
- A developer `id` on a bound element inside a `repeat()` row no longer forces the list onto the fallback renderer; the `id` is kept.
- The build no longer fails with `ENOENT` when emptying an existing output directory given as a `./`-prefixed path under Bun 1.4 on Windows.
- `when()` blocks now compile their content as a full sub-template. Event handlers on elements inside a `when()` block were never bound, a `whenElse()` or `repeat()` inside a `when()` block corrupted the surrounding template (a nested `repeat()` crashed at mount), an event handler inside a `when()` block truncated the content that followed it, and a binding inside a nested `when()` registered a phantom binding on the outer block.
- `whenElse()` initialises nested `when`/`whenElse` blocks from the branch they belong to; the else branch previously received none and the then branch received both.
- Conditions that cannot be evaluated at compile time (local non-signal values, signals without a known initializer) defer branch selection to mount instead of pre-rendering the else branch.
- Runtime helpers used only inside nested directive branches (for example a `when()` inside a `whenElse()` branch) are now imported.
- Child components mounted inside a directive nested in a `whenElse()` else branch are set up by the correct branch initializer.
- `computed()` no longer drops a change notification when another subscriber reads the computed before its deferred notification runs.
- The HTML parser tracks nested object-literal braces inside template-literal expressions.
- Template parse diagnostics no longer call an unbound logger method.
- `when()`, `whenElse()` and nested `repeat()` inside a `repeat()` row now see the row's item and index: conditions, branch templates and inner lists read them through row-scoped signals, so a row updates its nested directives when its item changes. Row event handlers that do not mention the item (a plain function reference, or an arrow that only calls a component function) are attached and called with the event.
- Form and state attributes (`value`, `checked`, `selected`, `disabled`, `open`, `hidden`, `readonly`, `required`, `multiple`, `indeterminate`, `muted`) are written as DOM properties, so `checked=${false}` unchecks and `value=${name()}` moves the field's live value; the static template ships no attribute for a bound boolean. `null` and `undefined` render as empty text instead of the words.
- One attribute grammar: static text around an expression is kept (`class="btn ${kind()}"` writes `btn primary`), `style=${expr}` writes `cssText`, `style="color: ${c()}"` binds the property, and a `:`-prefixed attribute is a build error (THANE006) instead of a literal attribute named `:src`.
- The string fallback row renderer is gone. Every `repeat()` list, including one inside a `when()` or `whenElse()` branch, uses the keyed row path with cloned templates, guarded updates and delegated events. A row template with more than one root element, or none, is a build error (THANE007) that says what to wrap; a row that is only a `whenElse()` is named as such. Rows whose only binding is a component signal were left unbound by the clone-only path; they are bound now.
- Developer `id` attributes are kept on attribute- and style-bound elements and on `whenElse()` branch roots (previously the compiler's id won, or the branch never hid). Generated code refers to such elements through a derived variable, so an id can neither shadow a component variable nor need to be a valid identifier.
- `props.count()` read directly in a template is a tracked signal read, as the Components doc shows; `const count = props.count` is no longer needed.
- `${index}` bindings follow the row: after a reorder or a removal, every row at a new position is refreshed. Lists without an index binding do no extra work.
- The router mounts the route again when only the query changes (`navigate('/a?x=2')` from `/a?x=1`), so `route.searchParams` is current; a hash-only change keeps the instance. Persisting the scroll position no longer rewrites the history entry's URL to the bare pathname, so browser back returns to the full URL.
- Compiler exceptions fail the build with the diagnostic instead of shipping the component uncompiled.

### Changed

- TypeScript updated from 5.9 to 6.0.3, the last release that ships the JavaScript compiler API the Thane compiler and linter are built on. TypeScript 7 (the Go-native compiler) does not expose that API until 7.1 and is not yet a drop-in replacement.
- Toolchain: Bun 1.4.2, esbuild 0.28, Playwright 1.63, Prettier 3.9, `@types/bun` 1.4 and `@types/node` 26.
- Repository layout: documentation lives in `docs/` with the contributing guides under `docs/contributing/`; the benchmark and both store example apps live under `example-apps/`; e2e builds and Playwright output stay under `e2e/`.
- The Thane store example depends on the framework through `bun link` instead of copying the repository into its `node_modules`.
- Compiler: type sync and type checking are scoped to the project that owns the entry point instead of the current working directory, so building from the repository root no longer writes `.thane` folders into unrelated projects.
- The benchmark app depends on `example-apps/benchmark/thane.tgz`, produced by `bun run test:benchmark`, instead of a version-numbered tarball that went stale on every release.
- Documentation: the CLI reference now lists the real flag spellings and the JSON/JSONC config file format; directive docs describe nesting inside `when()` blocks and compile-time branch selection.

Entries for earlier releases were not recorded.
