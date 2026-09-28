import { defineComponent, signal, html, when, whenElse, repeat } from 'thane';
import { expose } from '../shared/expose.js';

// The whitespace between a text binding and an element or directive next to it,
// rendered. Rows first, then the same at component level and in a whenElse() branch. The last
// paragraph is whitespace between two elements, which is not text and still goes.
export const H53 = defineComponent('hardening-h53', () => {
  const items = signal([{ id: 1, first: 'John', last: 'Doe', on: true }]);
  const a = signal('A');
  const b = signal('B');
  const on = signal(true);
  expose('h53', { items, a, b, on });
  return {
    // prettier-ignore
    template: html`<div class="h53">
      <ul class="h53-label">${repeat(items(), (it) => html`<li><b>Name:</b> ${it.first}</li>`)}</ul>
      <ul class="h53-check">${repeat(items(), (it) => html`<li><input type="checkbox"> ${it.first}</li>`)}</ul>
      <ul class="h53-before">${repeat(items(), (it) => html`<li>${it.first} <b>x</b></li>`)}</ul>
      <ul class="h53-when">${repeat(items(), (it) => html`<li>${it.first} <span ${when(it.on)}>w</span> ${it.last}</li>`)}</ul>
      <ul class="h53-whenelse">${repeat(items(), (it) => html`<li>${it.first} ${whenElse(it.on, html`<i>y</i>`, html`<i>n</i>`)} ${it.last}</li>`)}</ul>
      <p class="h53-cbefore">${a()} <b>x</b></p>
      <p class="h53-cwhen">${a()} <span ${when(on())}>w</span> ${b()}</p>
      <p class="h53-cwhenelse">${a()} ${whenElse(on(), html`<i>y</i>`, html`<i>n</i>`)} ${b()}</p>
      ${whenElse(on(), html`<p class="h53-branch">${a()} <b>x</b></p>`, html`<p class="h53-branch">none</p>`)}
      <p class="h53-elements"><b>x</b> <i>y</i></p>
      <p class="h53-lines"><b>x</b>
        <i>y</i></p>
    </div>`,
  };
});
