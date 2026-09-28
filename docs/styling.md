# Styling

Thane uses **Light DOM** — components render as regular DOM elements, not inside Shadow DOM. Styles are scoped automatically via CSS Nesting and `adoptedStyleSheets`.

## Scoped Styles

Return a `styles` property from your component using the `css` tagged template:

```typescript
export const Card = defineComponent('ui-card', () => ({
  template: html`<div class="card"><h1>Hello</h1></div>`,
  styles: css`
    .card {
      padding: 1rem;
      border: 1px solid #ddd;

      & h1 {
        color: blue;
      }
    }
  `,
}));
```

At runtime, the styles are automatically scoped to the component's selector class (`.ui-card`). The CSS becomes:

```css
.ui-card .card {
  padding: 1rem;
  border: 1px solid #ddd;

  & h1 {
    color: blue;
  }
}
```

This scoping uses `adoptedStyleSheets` — styles are registered once per component type, regardless of how many instances exist.

## `:host` Selector

Use `:host` to style the component's root element itself:

```typescript
styles: css`
  :host {
    display: block;
    max-width: 800px;
    margin: 0 auto;
  }
`;
```

`:host` is rewritten to the component's selector class (e.g., `.ui-card`). This targets the element that has the component class applied.

### `:host()` with Conditions

```typescript
styles: css`
  :host(.active) {
    border-color: blue;
  }
`;
```

Becomes `.ui-card.active { border-color: blue; }`. The condition can be any compound selector, including pseudo-classes with their own parentheses: `:host(:not(.disabled).active)` becomes `.ui-card:not(.disabled).active`.

### `:host-context()`

`:host-context(X)` styles the component when it sits inside an element that matches `X`, typically a theme class on a page wrapper:

```typescript
styles: css`
  :host-context(.dark) .title {
    color: white;
  }
`;
```

The compiler rewrites it to `.dark & .title`, which is scoped to `.dark .ui-card .title`. It matches when an **ancestor** matches `X`; to style the component element itself by its own class, use `:host(X)`. The argument is one compound selector, as in Shadow DOM CSS.

## CSS Nesting

Thane relies on native CSS Nesting (the `&` selector). This requires modern browsers:

| Chrome | Firefox | Safari | Edge |
| :----: | :-----: | :----: | :--: |
|  120+  |  117+   | 17.2+  | 120+ |

Use `&` for nested selectors:

```typescript
styles: css`
  .nav {
    display: flex;

    & .link {
      color: inherit;

      &:hover {
        color: blue;
      }
    }
  }
`;
```

## At-Rules and Comments

- `@media`, `@supports`, `@container` and `@layer` blocks are scoped inside, like top-level rules.
- `@layer a, b;` declares the layers' order as usual (the compiler writes it as one empty `@layer` block per name).
- `@charset` is removed: it means nothing in a stylesheet string.
- `@import` is removed, and the build prints a warning. Thane applies every stylesheet as a constructed stylesheet (`adoptedStyleSheets`), and browsers ignore `@import` there. Load such a stylesheet with a `<link>` in `index.html` instead.
- `@keyframes` and `@font-face` are copied as written, so keyframe names are global: give them a prefix of your own.
- `@namespace svg url(http://www.w3.org/2000/svg);` works as usual, so `svg|rect` selects the SVG `rect` in the component. The compiler writes an empty `{}` after the statement, which the browser ignores, so the rule after it is scoped like any other.

Comments are removed from stylesheets at build time, in development and production builds.

## CSS File Imports

Import `.css` files as string exports:

```typescript
import styles from './Card.module.css';

export const Card = defineComponent('ui-card', () => ({
  template: html`<div class="card">...</div>`,
  styles,
}));
```

The compiler bundles the CSS file and exports its content as a string. Add `thane/client` to your `tsconfig.json` types to get proper TypeScript support for `.css` imports:

```json
{
  "compilerOptions": {
    "types": ["thane/client"]
  }
}
```

The `client.d.ts` file declares:

```typescript
declare module '*.css' {
  const css: string;
  export default css;
}
```

## Global Styles

Use `registerGlobalStyles()` for styles that apply globally — resets, typography, theme variables:

```typescript
import { registerGlobalStyles } from 'thane';

const resetStyles = css`
  *,
  *::before,
  *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
`;

const themeStyles = css`
  :root {
    --primary: #2563eb;
    --surface: #ffffff;
  }
`;

registerGlobalStyles(resetStyles, themeStyles);
```

Global styles:

- Are **not scoped** — they apply to the entire document.
- Are **deduplicated** — calling `registerGlobalStyles` with the same CSS text twice has no effect.
- Use `adoptedStyleSheets` on the document for efficient application.

## Light DOM Implications

Because Thane uses Light DOM (no Shadow DOM):

- **Parent styles cascade into children.** A parent's `.card h1` rule applies to `<h1>` inside child components too.
- **Child styles don't leak to siblings or parents** (because they're scoped to the component's class).
- **Global CSS frameworks** (Tailwind, Bootstrap) work without any special integration.
- **CSS variables** work naturally across component boundaries.

## Selector Minification

In production builds (`thane build --prod`), component selectors are minified to shorter class names, reducing both CSS and HTML size. `product-card` becomes something like `a-b` in the registration, in the host element the compiler creates, and in every component stylesheet that addresses `.product-card`.

The renaming is decided from your sources before the build compiles anything, and it is conservative: a selector is renamed only when every appearance of its text in the project is a place the compiler writes itself. Anything else keeps the selector's name everywhere, so a rename can never leave one half of a pair behind:

- a string in your code: a route such as `/product-card/:id`, an asset path, `querySelector('product-card')`;
- a `class` attribute or a hand-written `<product-card>` tag in a template;
- a stylesheet that is served as a static file rather than imported, or one imported from a package;
- a comment or a quoted string inside CSS.

Nothing breaks in those cases; that one selector simply stays long. Emitted JavaScript is never searched or rewritten, so a library that happens to contain the same text is not affected either way.

Only selectors shaped like a custom element name (`my-card`, with a hyphen) are renamed; a single-word selector keeps its name.

## CSS Variables for Theming

Define variables in a parent or global style, and consume them in components:

```typescript
// Global theme
registerGlobalStyles(css`
  :root {
    --accent: #2563eb;
    --radius: 8px;
  }
`);

// Component uses theme variables
styles: css`
  .button {
    background: var(--accent);
    border-radius: var(--radius);
  }
`;
```

← [Back to Docs](README.md)
