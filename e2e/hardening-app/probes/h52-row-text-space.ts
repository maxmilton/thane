import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

// H-52 (K23): the text between row text bindings, one shape per list. The paragraphs are the same
// shapes at component level, for comparison. The last four shapes (a binding next to an element) lose
// their space too (H-53).
export const H52 = defineComponent('hardening-h52', () => {
  const items = signal([{ id: 1, first: 'John', mid: 'Q', last: 'Doe' }]);
  const label = signal('L');
  const a = signal('A');
  const b = signal('B');
  expose('h52', { items, label, a, b });
  return {
    // prettier-ignore
    template: html`<div class="h52">
      <ul class="h52-space">${repeat(items(), (it) => html`<li>${it.first} ${it.last}</li>`)}</ul>
      <ul class="h52-two">${repeat(items(), (it) => html`<li>${it.first}  ${it.last}</li>`)}</ul>
      <ul class="h52-newline">${repeat(items(), (it) => html`<li>${it.first}
        ${it.last}</li>`)}</ul>
      <ul class="h52-padded">${repeat(items(), (it) => html`<li>
        ${it.first} ${it.last}
      </li>`)}</ul>
      <ul class="h52-three">${repeat(items(), (it) => html`<li>${it.first} ${it.mid} ${it.last}</li>`)}</ul>
      <ul class="h52-signal">${repeat(items(), (it) => html`<li>${it.first} ${label()}</li>`)}</ul>
      <ul class="h52-dash">${repeat(items(), (it) => html`<li>${it.first}-${it.last}</li>`)}</ul>
      <ul class="h52-adjacent">${repeat(items(), (it) => html`<li>${it.first}${it.last}</li>`)}</ul>
      <ul class="h52-around">${repeat(items(), (it) => html`<li>x ${it.first} y</li>`)}</ul>
      <ul class="h52-when">${repeat(items(), (it) => html`<li><span ${when(it.id > 0)}>${it.first} ${it.last}</span></li>`)}</ul>
      <p class="h52-component">${a()} ${b()}</p>
      <ul class="h52-before">${repeat(items(), (it) => html`<li>${it.first} <b>b</b></li>`)}</ul>
      <ul class="h52-after">${repeat(items(), (it) => html`<li><b>b</b> ${it.first}</li>`)}</ul>
      <p class="h52-cbefore">${a()} <b>b</b></p>
      <p class="h52-cafter"><b>b</b> ${a()}</p>
    </div>`,
  };
});
