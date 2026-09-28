import { defineComponent, signal } from 'thane';
import { Kid } from '../shared/kid.js';

// I1 (H-29): a child component in a row whose props use the row index under a custom name.
export const I1 = defineComponent('hardening-i1', () => {
  const items = signal(['x', 'y']);
  return {
    template: html`<ul>
      ${repeat(items(), (it, i) => html`<li class="i1-row">${Kid({ label: it + i })}</li>`)}
    </ul>`,
  };
});
