import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

// P18 (H-05): a static sibling before a repeat() in the same container.
export const P18 = defineComponent('hardening-p18', () => {
  const items = signal(['a', 'b']);
  expose('p18', { items });
  return {
    template: html`<ul class="p18">
      <li class="p18-head">H</li>
      ${repeat(items(), (i) => html`<li class="p18-item">${i}</li>`)}
    </ul>`,
  };
});
