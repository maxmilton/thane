import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

// R1: a keyed list reordered while a row goes (the reconciler's general path), then appended to.
// A row moved after the last one went after the list's anchor, so the next row was added before it.
export const R1 = defineComponent('hardening-r1', () => {
  const items = signal([{ id: 'A' }, { id: 'B' }, { id: 'C' }]);
  expose('r1', { items });
  return {
    template: html`<ul class="r1">
      ${repeat(
        items(),
        (item) => html`<li class="r1-item">${item.id}</li>`,
        null,
        (item) => item.id,
      )}
      <li class="r1-tail">T</li>
    </ul>`,
  };
});
