import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

// P1: a method call on the row item in a row text binding.
export const P1 = defineComponent('hardening-p1', () => {
  const items = signal([
    { id: 1, name: 'alpha' },
    { id: 2, name: 'beta' },
  ]);
  expose('p1', { items });
  return {
    template: html`<ul>
      ${repeat(
        items(),
        (it) => html`<li class="p1-row">${it.name.toUpperCase()}</li>`,
        null,
        (it) => it.id,
      )}
    </ul>`,
  };
});
