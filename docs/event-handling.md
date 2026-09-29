# Event Handling

Bind DOM events using the `@event` syntax inside `html` templates.

## Basic Event Binding

```typescript
const handleClick = () => console.log('Clicked!');

template: html`<button @click=${handleClick}>Click me</button>`;
```

The compiler transforms `@click=${handler}` into an `addEventListener('click', handler)` call.

A function (an arrow function or a function expression) or a reference (`handler`, `menu.close`) is the
listener: it receives the event. Any other expression, such as a call, runs on the event as written:
`@click=${navigate('/')}` navigates on click, and `@click=${select(item.id)}` selects the item.

## Inline Handlers

Use inline arrow functions directly:

```typescript
template: html`<button @click=${() => count(count() + 1)}>+1</button>`;
```

## Event Object

Handlers receive the standard DOM event object. The type check that `thane build`, `thane dev` and
`thane typecheck` run gives it the event's type, as lib.dom defines it: in `@click=${(e) => …}`, `e` is a
`PointerEvent`, and in `@keydown=${(e) => …}` a `KeyboardEvent`. A handler written for another event is a
type error there:

```typescript
template: html`<button @click=${(e: KeyboardEvent) => e.key}>Go</button>`;
// error TS1360: Type '(e: KeyboardEvent) => string' does not satisfy the expected type 'ThaneEventListener<"click">'.
```

An event that lib.dom does not know, such as a custom event, is typed `any`. Editors do not run this check, so
an untyped parameter is `any` in the editor; type it explicitly for completions there:

```typescript
const handleInput = (event: Event) => {
  const target = event.target as HTMLInputElement;
  query(target.value);
};

template: html`<input @input=${handleInput} />`;
```

For mouse events:

```typescript
const handleClick = (event: MouseEvent) => {
  console.log(event.clientX, event.clientY);
};

template: html`<div @click=${handleClick}>Click anywhere</div>`;
```

## Common Events

```typescript
template: html`
  <input @input=${onInput} @change=${onChange} @focus=${onFocus} @blur=${onBlur} />
  <form @submit=${onSubmit}>
    <button @click=${onClick}>Submit</button>
  </form>
  <div @keydown=${onKeyDown} @keyup=${onKeyUp}></div>
`;
```

## Event Methods

Call `.stopPropagation()` or `.preventDefault()` inside the handler:

```typescript
const addCurrentToCart = (event: Event) => {
  event.stopPropagation(); // prevent click from bubbling to parent
  addToCart(productId);
};

template: html`<button @click=${addCurrentToCart}>Add to Cart</button>`;
```

This pattern is used in the [e-commerce example app](examples/e-commerce-app.md) where a card click navigates to details, but the "Add to Cart" button inside the card needs to stop propagation.

## Prevent Default

```typescript
const handleSubmit = (event: Event) => {
  event.preventDefault();
  // custom form handling
};

template: html`<form @submit=${handleSubmit}>...</form>`;
```

## Navigate on Click

With the router, a plain `<a href="/about">` to a route already navigates in the app ([Links](routing.md#links)). To navigate from a click on something else, bind `navigate()` directly:

```typescript
template: html`
  <a @click=${navigate('/')}>Home</a>
  <a @click=${navigate('/about')}>About</a>
`;
```

Or with `preventDefault` for anchor elements:

```typescript
const goHome = (event: Event) => {
  event.preventDefault();
  navigate('/');
};

template: html`<a href="/" @click=${goHome}>Home</a>`;
```

← [Back to Docs](README.md)
